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
  cors(req, res, async () => {
    const {
      title,
      description,
      payload,
      provider_token,
      currency,
      prices,
      need_email,
      send_email_to_provider,
      provider_data,
  //    email,
      telegram_user_id,
      telegram_username,
      device_info,
    } = req.body;

    // Validate input
  /*  if (
      !title ||
      !description ||
      !payload ||
      !provider_token ||
      !currency ||
      !prices ||
      !provider_data ||
 //     !email ||
      !telegram_user_id
    ) {
      console.error('Missing required fields in request body:', req.body);
      return res.status(400).json({ message: 'Missing required fields in request body.' });
    } */

    // Generate an order ID
  //  const orderId = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const createInvoiceLinkUrl = `https://api.telegram.org/bot${botToken}/createInvoiceLink`;
    const invoicePayload = {
      title,
      description,
      payload,
    //  payload: orderId, // Use the generated order ID as the payload
      need_email,
      send_email_to_provider,
      provider_token,
      currency,
      prices,
      provider_data: typeof provider_data === 'string' ? provider_data : JSON.stringify(provider_data),
    };

    console.log('Payload to Telegram:', invoicePayload);

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

    if (!paymentInfo || !chatId) {
      console.error('Missing payment information or chat ID:', update.message);
      return res.status(400).send('Missing payment information or chat ID.');
    }

    const signal = {
      chat_id: chatId,
      telegram_user_id: req.body.telegram_user_id || null,
      telegram_username: paymentInfo.telegram_username || 'Unknown',
      email: paymentInfo.email || null,
      order_id: paymentInfo.invoice_payload || 'Unknown',
      product_name: paymentInfo.description || 'Unknown',
      device_info: paymentInfo.device_info || 'Unknown',
      status: 'paid',
      amount: paymentInfo.total_amount / 100,
      currency: paymentInfo.currency,
      date: new Date(),
    };

    try {
      await db.collection('paymentSignals').add(signal);
      console.log('Payment signal written to Firestore:', signal);
    } catch (error) {
      console.error('Error writing payment signal to Firestore:', error.message);
    }
  }
  // Retrieve booking details from payload
  const payload = JSON.parse(paymentInfo.invoice_payload);
  const bookingDetails = payload.bookingDetails;

  // Send confirmation message
  await axios.post(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      chat_id: chatId,
      text: `Спасибо за оплату! Вы забронировали консультацию:\n\n` +
            `Специалист: ${bookingDetails.specialistId || 'Не указан'}\n` +
            `Дата: ${bookingDetails.date || 'Не указана'}\n` +
            `Время: ${bookingDetails.time || 'Не указано'}\n\n` +
            `Скоро с вами свяжутся для подтверждения!`,
    }
  );

  res.status(200).send('Webhook received');
});


