const express = require('express');
const stripe = require('stripe');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');

dotenv.config();

const app = express();
// Add your Stripe Secret Key here directly if .env gives you trouble, 
// but .env is recommended for security.
const stripeClient = stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.static('public')); // Serves your HTML file
app.use(express.json());

// ROUTE FIX: Serve bagis.html automatically at the root URL (/)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bagis.html'));
});

// Helper to load config with fallback
const loadConfig = () => {
    try {
        const rawData = fs.readFileSync('config.json');
        return JSON.parse(rawData);
    } catch (error) {
        // Hardcoded backup if file fails
        return {
            monthly_amounts: [50, 100, 200, 300, 500, 1000],
            onetime_amounts: [20, 30, 50, 100, 200],
            customer_portal_link: "https://billing.stripe.com/p/login/test_28E6oI3tO1h76Ku71cd3i00"
        };
    }
};

// Configuration Endpoint
app.get('/api/config', (req, res) => {
    const config = loadConfig();
    res.json(config);
});

// Verify Session Endpoint (New)
app.get('/api/checkout-session', async (req, res) => {
    const { sessionId } = req.query;
    if (!sessionId) {
        return res.status(400).json({ error: 'Missing session_id' });
    }

    try {
        // Expand payment objects to find the actual fee
        const session = await stripeClient.checkout.sessions.retrieve(sessionId, {
            expand: [
                'payment_intent.latest_charge.balance_transaction',
                'subscription.latest_invoice.charge.balance_transaction'
            ]
        });
        
        // 1. Get Total Paid
        const amountTotal = session.amount_total / 100; // Convert cents to dollars
        
        // 2. Determine Exact Stripe Fee
        let feeAmount = 0;
        
        if (session.payment_intent && session.payment_intent.latest_charge && session.payment_intent.latest_charge.balance_transaction) {
            // One-Time Payment Fee
            feeAmount = session.payment_intent.latest_charge.balance_transaction.fee / 100;
        } else if (session.subscription && session.subscription.latest_invoice && session.subscription.latest_invoice.charge && session.subscription.latest_invoice.charge.balance_transaction) {
            // Subscription Payment Fee
            feeAmount = session.subscription.latest_invoice.charge.balance_transaction.fee / 100;
        } else {
            // Fallback: Estimate if transaction is pending or object not expanded
            // Note: This matches the frontend logic (2.2% + 0.30) to give a close approximation
            feeAmount = (amountTotal * 0.022) + 0.30;
        }

        const netAmount = amountTotal - feeAmount;

        // Determine type from metadata or mode
        let paymentType = session.metadata?.payment_type || 'One-Time';
        if(session.mode === 'subscription') paymentType = 'Monthly';

        res.json({
            amount: amountTotal.toFixed(2),
            net: netAmount.toFixed(2),
            fee: feeAmount.toFixed(2),
            type: paymentType,
            customer_email: session.customer_details?.email
        });
    } catch (error) {
        console.error('Error retrieving session:', error);
        res.status(500).json({ error: 'Failed to retrieve session details' });
    }
});

// Checkout Session Endpoint
app.post('/create-checkout-session', async (req, res) => {
    const { amount, isMonthly, customerDetails } = req.body;
    // Extract contributionType from the details sent by frontend
    const { name, email, phone, notes, contributionType } = customerDetails || {};

    // Normalize and validate amount on server side (prevent negative/zero values)
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ error: 'Invalid donation amount.' });
    }

    // Convert to cents and ensure at least 1 cent
    const unitAmount = Math.round(parsedAmount * 100);
    if (unitAmount < 1) {
        return res.status(400).json({ error: 'Invalid donation amount (too small).' });
    }

    // Optional: Enforce max amount on server too for safety (e.g., $10,000)
    const MAX_CENTS = 10000 * 100; // $10,000 in cents
    if (unitAmount > MAX_CENTS) {
        return res.status(400).json({ error: 'Donation amount exceeds the maximum limit of $10,000.' });
    }
    
    // Default to localhost if DOMAIN is not set in .env
    const domain = process.env.DOMAIN || 'http://localhost:4242';

    try {
        // Construct Metadata object to store in Stripe
        const metadata = {
            Source_app: 'Bagis-Web',
            customer_name: name,
            customer_email: email, // Added email to metadata
            customer_phone: phone,
            customer_notes: notes || '',
            contribution_type: contributionType || 'Donation', // e.g., "Scholarship"
            payment_type: isMonthly ? 'Monthly' : 'One-Time'
        };

        const session = await stripeClient.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        // Dynamic Product Name: e.g., "Monthly Scholarship" or "One-Time Alms"
                        name: isMonthly ? `Monthly ${contributionType || 'Donation'}` : `One-Time ${contributionType || 'Donation'}`,
                        description: isMonthly ? 'Recurring monthly support' : 'Single contribution',
                    },
                    unit_amount: unitAmount, // Stripe expects cents (validated server-side)
                    // Ensure we do not apply tax via price definition
                    tax_behavior: 'unspecified',
                    ...(isMonthly && { recurring: { interval: 'month' } }),
                },
                quantity: 1,
            }],
            mode: isMonthly ? 'subscription' : 'payment',
            // Explicitly disable Stripe Automatic Tax for this Checkout Session
            automatic_tax: { enabled: false },
            // Pass session_id to success page
            success_url: `${domain}/success.html?session_id={CHECKOUT_SESSION_ID}`, 
            cancel_url: `${domain}/bagis.html`,    // Redirect back to form on cancel
            customer_email: email, // Auto-fills email in Stripe checkout
            metadata: metadata,
            // For subscriptions, metadata goes here:
            subscription_data: isMonthly ? {
                metadata: metadata
            } : undefined,
            // For one-time payments, metadata goes here:
            payment_intent_data: !isMonthly ? {
                metadata: metadata
            } : undefined,
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error("Stripe Error:", error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = 4242;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
