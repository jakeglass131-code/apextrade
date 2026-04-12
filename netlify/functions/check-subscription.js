const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  try {
    const { email, sessionId } = JSON.parse(event.body || "{}");

    // If we have a checkout session ID, verify it directly
    if (sessionId) {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["subscription", "customer"],
      });

      if (session.payment_status === "no_payment_required" || session.payment_status === "paid") {
        const sub = session.subscription;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            active: true,
            status: sub ? sub.status : "active",
            plan: sub?.metadata?.plan || "pro",
            trial: sub?.status === "trialing",
            trialEnd: sub?.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
            email: session.customer_email || session.customer?.email || email,
            customerId: session.customer?.id || session.customer,
          }),
        };
      }
    }

    // Otherwise look up by email
    if (!email) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Email or sessionId required" }),
      };
    }

    const customers = await stripe.customers.list({ email, limit: 1 });
    if (!customers.data.length) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ active: false, status: "none" }),
      };
    }

    const customer = customers.data[0];
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 5,
    });

    // Find an active or trialing subscription
    const activeSub = subscriptions.data.find(
      (s) => s.status === "active" || s.status === "trialing"
    );

    if (!activeSub) {
      // Check for cancelled but still in period
      const graceSub = subscriptions.data.find(
        (s) => s.status === "canceled" && s.current_period_end * 1000 > Date.now()
      );

      if (graceSub) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            active: true,
            status: "cancelling",
            plan: graceSub.metadata?.plan || "pro",
            periodEnd: new Date(graceSub.current_period_end * 1000).toISOString(),
            email,
            customerId: customer.id,
          }),
        };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ active: false, status: "expired", email, customerId: customer.id }),
      };
    }

    const plan = activeSub.metadata?.plan || "pro";
    const item = activeSub.items.data[0];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        active: true,
        status: activeSub.status,
        plan,
        trial: activeSub.status === "trialing",
        trialEnd: activeSub.trial_end ? new Date(activeSub.trial_end * 1000).toISOString() : null,
        periodEnd: new Date(activeSub.current_period_end * 1000).toISOString(),
        cancelAtPeriodEnd: activeSub.cancel_at_period_end,
        priceId: item?.price?.id || null,
        email,
        customerId: customer.id,
      }),
    };
  } catch (err) {
    console.error("Check subscription error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
