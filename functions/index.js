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
    } = req.body;

    // Validate input
    if (!title || !description || !payload || !provider_token || !currency || !prices) {
      console.error('Missing required fields in request body:', req.body);
      return res.status(400).json({ message: 'Missing required fields in request body.' });
    }

    const createInvoiceLinkUrl = `https://api.telegram.org/bot${botToken}/createInvoiceLink`;

    try {
      console.log('Sending payload to Telegram API:', {
        title,
        description,
        payload,
        provider_token,
        currency,
        prices,
      });

      const response = await axios.post(createInvoiceLinkUrl, {
        title,
        description,
        payload,
        provider_token,
        currency,
        prices,
      });

      if (response.data.ok) {
        const invoiceLink = response.data.result;

        console.log('Telegram API response:', response.data);

        res.status(200).json({
          message: 'Invoice link created successfully',
          invoice_link: invoiceLink,
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

  res.status(200).send('Webhook received');
});




