const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  const sig = event.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    // Verify webhook signature if secret is configured
    if (endpointSecret && sig) {
      stripeEvent = stripe.webhooks.constructEvent(event.body, sig, endpointSecret);
    } else {
      stripeEvent = JSON.parse(event.body);
      console.warn("⚠ Webhook signature not verified — STRIPE_WEBHOOK_SECRET not set");
    }
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  const { type, data } = stripeEvent;
  const obj = data.object;

  try {
    switch (type) {
      // ── Trial started / subscription created ──
      case "customer.subscription.created": {
        const customer = await stripe.customers.retrieve(obj.customer);
        console.log(`✅ New subscription: ${customer.email} | Plan: ${obj.metadata?.plan || "unknown"} | Status: ${obj.status} | Trial ends: ${obj.trial_end ? new Date(obj.trial_end * 1000).toISOString() : "none"}`);
        break;
      }

      // ── Subscription updated (upgrade/downgrade/trial end) ──
      case "customer.subscription.updated": {
        const customer = await stripe.customers.retrieve(obj.customer);
        console.log(`🔄 Subscription updated: ${customer.email} | Status: ${obj.status} | Cancel at period end: ${obj.cancel_at_period_end}`);

        // If trial just ended and payment succeeded
        if (obj.status === "active" && !obj.trial_end) {
          console.log(`💳 Trial converted to paid: ${customer.email}`);
        }
        break;
      }

      // ── Subscription cancelled ──
      case "customer.subscription.deleted": {
        const customer = await stripe.customers.retrieve(obj.customer);
        console.log(`❌ Subscription cancelled: ${customer.email} | Ended: ${new Date(obj.ended_at * 1000).toISOString()}`);
        break;
      }

      // ── Successful payment ──
      case "invoice.payment_succeeded": {
        const customer = await stripe.customers.retrieve(obj.customer);
        console.log(`💰 Payment succeeded: ${customer.email} | Amount: $${(obj.amount_paid / 100).toFixed(2)} ${obj.currency.toUpperCase()}`);
        break;
      }

      // ── Failed payment ──
      case "invoice.payment_failed": {
        const customer = await stripe.customers.retrieve(obj.customer);
        console.log(`⚠ Payment failed: ${customer.email} | Amount: $${(obj.amount_due / 100).toFixed(2)} | Attempt: ${obj.attempt_count}`);
        break;
      }

      // ── Checkout completed ──
      case "checkout.session.completed": {
        console.log(`🎉 Checkout completed: ${obj.customer_email || obj.customer} | Mode: ${obj.mode}`);
        break;
      }

      // ── Trial will end soon (3 days before) ──
      case "customer.subscription.trial_will_end": {
        const customer = await stripe.customers.retrieve(obj.customer);
        console.log(`⏰ Trial ending soon: ${customer.email} | Ends: ${new Date(obj.trial_end * 1000).toISOString()}`);
        // TODO: Send email reminder via your email service
        break;
      }

      default:
        console.log(`Unhandled event: ${type}`);
    }
  } catch (err) {
    console.error(`Error processing ${type}:`, err);
    // Still return 200 so Stripe doesn't retry
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
