const functions = require('firebase-functions');
const axios = require('axios');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
const serviceAccount = require('./keys/serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const botToken = functions.config().telegram.bot_token;

// WooCommerce API Integration
const wooCommerceBaseURL = 'https://payments.timelabs.su/wp-json/wc/v3';
const consumerKey = 'ck_36e711a64d6b3aa9f11617e7b81c8b3c4792826b';
const consumerSecret = 'cs_b237028e1e0b096b29456249feee56fb69faa7c9';

async function syncProductsToFirestore() {
  try {
    const response = await axios.get(`${wooCommerceBaseURL}/products?per_page=50`, {
      auth: {
        username: consumerKey,
        password: consumerSecret,
      }
    });

    const products = response.data;

    const batch = db.batch();
    products.forEach((product) => {
      const productRef = db.collection('products').doc(product.id.toString());
      batch.set(productRef, {
        id: product.id,
        name: product.name,
        description: product.description.replace(/<[^>]*>?/gm, ''), // Remove HTML tags
        price: parseFloat(product.price) || 0,
        categories: product.categories.map((cat) => cat.name),
        image: product.images?.[0]?.src || '',
        link: product.permalink,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    console.log('Products synced to Firestore successfully!');    

  // Sync categories
    const categoryResponse = await axios.get(`${wooCommerceBaseURL}/products/categories`, {
      auth: {
        username: consumerKey,
        password: consumerSecret,
      },
    });

    const categories = categoryResponse.data;

    const categoryBatch = db.batch();
    categories.forEach((category) => {
      const categoryRef = db.collection('categories').doc(category.id.toString());
      categoryBatch.set(categoryRef, {
        id: category.id,
        name: category.name,
        slug: category.slug,
        description: category.description || '',
        order: category.menu_order || 0,
        count: category.count || 0,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await categoryBatch.commit();
    console.log('Categories synced to Firestore successfully!');
  } catch (error) {
    console.error('Error syncing products and categories to Firestore:', error);
  }
}

// Firebase Function (backend)
const syncCouponsToFirestore = async () => {
  try {
    // Fetch coupons from WooCommerce API
    const response = await axios.get(`${wooCommerceBaseURL}/coupons?per_page=50`, {
      auth: { username: consumerKey, password: consumerSecret }
    });

    const coupons = response.data;

    // Batch write to Firestore
    const batch = db.batch();
    coupons.forEach((coupon) => {
      const couponRef = db.collection('coupons').doc(coupon.code); // Use coupon code as the document ID
      batch.set(couponRef, {
        code: coupon.code,
        discountType: coupon.discount_type, // e.g., "percent" or "fixed_cart"
        amount: parseFloat(coupon.amount),
        usageLimit: coupon.usage_limit || 0,
        usedCount: coupon.usage_count || 0,
        expiryDate: coupon.date_expires || null,
        productIds: coupon.product_ids || [],
        status: coupon.status === "publish" ? "active" : "expired"
      });
    });

    await batch.commit();
    console.log('Coupons synced to Firestore!');
  } catch (error) {
    console.error('Error syncing coupons:', error);
  }
};

// Trigger this function periodically (e.g., every 1 hour)
exports.scheduledSyncCoupons = functions.pubsub.schedule('every 1 hour').onRun(async () => {
  await syncCouponsToFirestore();
});

// Firebase Function (backend)
exports.syncCouponUsageToWordPress = functions.firestore
  .document('coupons/{couponCode}')
  .onUpdate(async (change, context) => {
    const newData = change.after.data();
    const oldData = change.before.data();

    // Only trigger if usedCount changed
    if (newData.usedCount === oldData.usedCount) return;

    try {
      await axios.put(
        `${wooCommerceBaseURL}/coupons/${context.params.couponCode}`,
        { usage_count: newData.usedCount },
        { auth: { username: consumerKey, password: consumerSecret } }
      );
      console.log(`Coupon ${context.params.couponCode} usage synced to WordPress.`);
    } catch (error) {
      console.error('Error syncing coupon usage:', error);
    }
  });

exports.generateTimeslots = functions.pubsub.schedule('every 24 hours').onRun(async () => {
  const specialistsSnapshot = await db.collection('specialists').get();
  const today = new Date();

  specialistsSnapshot.forEach(async (doc) => {
    const specialist = doc.data();
    const availability = { ...specialist.availability };

    // Generate slots for the next 30 days
    for (let i = 1; i <= 30; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const dateKey = date.toISOString().split('T')[0];

      if (!availability[dateKey]) {
        // Example timeslots; customize as needed
        availability[dateKey] = ['10:00', '12:00', '14:00', '16:00'];
      }
    }

    // Update specialist's availability
    await doc.ref.update({ availability });
  });

  console.log('Timeslots generated successfully.');
});

// Function to fetch products from WooCommerce
exports.getWooCommerceProducts = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    try {
      const productsSnapshot = await db.collection('products').get();
      const products = productsSnapshot.docs.map((doc) => doc.data());
      res.status(200).json({ products });
    } catch (error) {
      console.error('Error fetching products from Firestore:', error);
      res.status(500).json({ message: 'Failed to fetch products.' });
    }
  });
});

exports.manualSyncProducts = functions.https.onRequest((req, res) => {
  syncProductsToFirestore()
    .then(() => res.status(200).json({ message: 'Products synced successfully' }))
    .catch((error) => res.status(500).json({ message: error.message }));
});

exports.manualSyncCoupons = functions.https.onRequest((req, res) => {
  syncCouponsToFirestore()
    .then(() => res.status(200).json({ message: 'Coupons synced successfully' }))
    .catch((error) => res.status(500).json({ message: error.message }));
});


// Scheduled function to sync products to Firestore
exports.scheduledSyncProducts = functions.pubsub.schedule('every 10 minutes').onRun(async () => {
  console.log('Scheduled sync started...');
  try {
    await syncProductsToFirestore();
    console.log('Scheduled sync completed.');
  } catch (error) {
    console.error('Error during scheduled sync:', error);
  }
});



// Cloud function to handle creating invoice links
exports.createInvoiceLink = functions.https.onRequest((req, res) => {
  console.log('Received request:', req.body);
  cors(req, res, async () => {
    const {
      title,
      description,
      payload,
      provider_token,
      currency,
      prices,
      provider_data,
      email,
      telegram_user_id,
      telegram_username,
      device_info,
    } = req.body;

    // Validate input
    if (
      !title ||
      !description ||
      !payload ||
      !provider_token ||
      !currency ||
      !prices ||
      !provider_data ||
      !email ||
      !telegram_user_id
    ) {
      console.error('Missing required fields in request body:', req.body);
      return res.status(400).json({ message: 'Missing required fields in request body.' });
    } 

    // Parse the payload to extract the orderId
    let frontendPayload;
    try {
      frontendPayload = JSON.parse(payload);
    } catch (error) {
      console.error('Invalid payload format:', error);
      return res.status(400).json({ message: 'Payload must be a JSON string.' });
    }

    const orderId = frontendPayload.orderId; // ✅ Use the frontend's orderId

    const createInvoiceLinkUrl = `https://api.telegram.org/bot${botToken}/createInvoiceLink`;
    const invoicePayload = {
      title,
      description,      
      payload: payload, // Use the generated order ID as the payload
      email,
      provider_token,
      currency,
      prices,
      provider_data: typeof provider_data === 'string' ? provider_data : JSON.stringify(provider_data),
    };

    try {
      console.log('Sending payload to Telegram API:', invoicePayload);

      const response = await axios.post(createInvoiceLinkUrl, invoicePayload);

      if (response.data.ok) {
        const invoiceLink = response.data.result;

        console.log('Telegram API response:', response.data);

        // Save order details for tracking/debugging
        const orderDetails = {
          order_id: orderId,
          product_name: title,
          email,
          telegram_user_id,
          telegram_username: telegram_username || 'Unknown',
          device_info: device_info || 'Unknown',
          prices,
          provider_data,
          created_at: new Date(),
        };
        await db.collection('orderLogs').add(orderDetails);

        res.status(200).json({
          message: 'Invoice link created successfully',
          invoice_link: invoiceLink,
          order_id: orderId,
        });
      } else {
        console.error('Telegram API error:', {
          status: response.status,
          data: response.data,
        });
        res.status(500).json({ message: response.data.description });
      }
    } catch (error) {
      console.error('Error creating invoice link:', error.message);
      res.status(500).json({ message: 'Failed to create invoice link.' });
    }
  });
});



// Cloud function to handle webhook updates from Telegram
exports.webhook = functions.https.onRequest(async (req, res) => {
  const update = req.body;

  console.log('Received webhook update:', JSON.stringify(update, null, 2));

  if (update.pre_checkout_query) {
    const preCheckoutQuery = update.pre_checkout_query;

    console.log('Pre-checkout query received:', preCheckoutQuery);

    try {
      await axios.post(
        `https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`,
        {
          pre_checkout_query_id: preCheckoutQuery.id,
          ok: true,
        }
      );
      console.log('Pre-checkout query answered successfully');
    } catch (error) {
      console.error('Error answering pre-checkout query:', error.message);
    }
  }

  if (update.message?.successful_payment) {
    const paymentInfo = update.message.successful_payment;
    const chatId = update.message.chat.id;
    
    let payload;
    try {
      payload = JSON.parse(paymentInfo.invoice_payload);
      console.log('Parsed payload:', payload); // Debugging
    } catch (error) {
      console.error('Error parsing invoice_payload:', error.message);
      return res.status(400).send('Invalid invoice_payload format.');
    }

    const orderId = payload.orderId; // ✅ Use the same orderId from the frontend

    const signal = {
      chat_id: chatId,
      telegram_user_id: update.message.from?.id || null,
      telegram_username: update.message.from?.username || 'Unknown',
      email: update.message.from?.email || null,
      order_id: orderId,
      product_name: update.message.from?.description || 'Unknown',
      device_info: update.message.from?.device_info || 'Unknown',
      status: 'paid',
      amount: paymentInfo.total_amount / 100,
      currency: paymentInfo.currency,
      date: new Date(),
    };

 /*   if (signal.status === 'paid' && signal.order_id && signal.amount) {
      try {
        await db.collection('paymentSignals').add(signal);
        console.log('Payment signal written to Firestore:', signal);
      } catch (error) {
        console.error('Error writing payment signal to Firestore:', error.message);
      }
    } else {
      console.warn('Skipped writing signal due to missing or invalid data:', signal);
    } */

          // Use a transaction to prevent duplicates
    await db.runTransaction(async (transaction) => {
      const signalRef = db.collection('paymentSignals').doc(orderId);
      const doc = await transaction.get(signalRef);

      if (!doc.exists) {
        transaction.set(signalRef, signal);
        console.log('Payment signal written:', signal);
      }
    });
  
  
  try {
    await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text: `Спасибо за оплату! Вы забронировали консультацию:\n\n` +
              `Специалист: ${paymentData.bookingDetails?.specialistName || 'Не указан'}\n` +
              `Дата: ${paymentData.bookingDetails?.date || 'Не указана'}\n` +
              `Время: ${paymentData.bookingDetails?.time || 'Не указано'}\n\n` +
              `Скоро с вами свяжутся для подтверждения!`,
      }
    );
    console.log('Confirmation message sent successfully.');
  } catch (error) {
    console.error('Error sending confirmation message:', error.message);
  }
}

  res.status(200).send('Webhook received');
});


