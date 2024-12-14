const functions = require('firebase-functions');
const axios = require('axios');
const cors = require('cors')({ origin: true });
const admin = require('firebase-admin');
const PDFDocument = require('pdfkit');
const fs = require('fs');


// Initialize Firebase Admin SDK
const serviceAccount = require('./keys/serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const { getFirestore } = require('firebase-admin/firestore');
const db = admin.firestore();

// Use environment variable for bot token
const botToken = functions.config().telegram.bot_token;

// Cloud function to handle creating invoice links
exports.createInvoiceLink = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    console.log('Incoming request payload:', req.body);

    const {
      title,
      description,
      payload,
      provider_token,
      currency,
      prices,
    } = req.body;

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
        console.log('Telegram API response:', response.data);

        res.status(200).json({
          message: 'Invoice link created successfully',
          invoice_link: response.data.result,
        });
      } else {
        console.error('Telegram API error:', response.data.description);
        res.status(500).send(response.data.description);
      }
    } catch (error) {
      console.error('Error creating invoice link:', error.message);
      res.status(500).send('Failed to create invoice link.');
    }
  });
});

// Cloud function to handle webhook updates from Telegram
exports.webhook = functions.https.onRequest((req, res) => {
  const update = req.body;

  console.log('Received webhook update:', JSON.stringify(update, null, 2));

  // Handle pre-checkout query
  if (update.pre_checkout_query) {
    const preCheckoutQuery = update.pre_checkout_query;

    console.log('Pre-checkout query received:', preCheckoutQuery);

    try {
      axios
        .post(`https://api.telegram.org/bot${botToken}/answerPreCheckoutQuery`, {
          pre_checkout_query_id: preCheckoutQuery.id,
          ok: true,
        })
        .then(() => {
          console.log('Pre-checkout query answered successfully');
        })
        .catch((error) => {
          console.error('Error answering pre-checkout query:', error.message);
        });
    } catch (error) {
      console.error('Error processing pre-checkout query:', error.message);
    }
  }

  // Handle successful payment
  if (update.message?.successful_payment) {
    const paymentInfo = update.message.successful_payment;
    console.log('Payment received:', paymentInfo);

    // Emit payment signal to Firestore
    const signalData = {
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      status: 'paid',
      receipt: {
        title: paymentInfo.invoice_payload,
        amount: paymentInfo.total_amount / 100,
        currency: paymentInfo.currency,
      },
      chat_id: update.message.chat.id,
    };

    db.collection('paymentSignals').add(signalData)
      .then(() => console.log('Payment signal added to Firestore'))
      .catch((error) => console.error('Error writing to Firestore:', error));
  }

  res.status(200).send('Webhook received');
});


// Function to generate a receipt as a PDF
function generateReceipt(receiptData) {
  const doc = new PDFDocument();
  const filePath = `/tmp/receipt-${Date.now()}.pdf`;

  // Create the PDF
  doc.pipe(fs.createWriteStream(filePath));
  doc.fontSize(18).text('Receipt', { align: 'center' });
  doc.moveDown();
  doc.fontSize(14).text(`Date: ${receiptData.date.toLocaleString()}`);
  doc.text(`Product: ${receiptData.title}`);
  doc.text(`Amount: ${receiptData.amount} ${receiptData.currency}`);
  doc.end();

  doc.on('finish', () => {
    console.log(`Receipt generated at ${filePath}`);
    fs.unlinkSync(filePath); // Clean up the temporary file
  });
}
