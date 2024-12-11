const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = 3000;  // You can choose any port that is available

// Middleware to parse JSON request bodies
app.use(bodyParser.json());

// Your bot token from BotFather
const botToken = '7554393961:AAHBhyKtw6J_vGpGA6sEpa9RdxRgCg9fc4s';  // Replace 'YOUR_BOT_TOKEN' with the actual bot token

// Endpoint to send invoice
app.post('/payments/sendInvoice', async (req, res) => {
  const {
    chat_id,
    provider_token,
    start_parameter,
    title,
    description,
    currency,
    prices,
    payload,
  } = req.body;

  // Create the URL to send the request to Telegram
  const sendInvoiceUrl = `https://api.telegram.org/bot${botToken}/sendInvoice`;

  try {
    // Make the request to Telegram API to send an invoice
    const response = await axios.post(sendInvoiceUrl, {
      chat_id,
      provider_token,
      start_parameter,
      title,
      description,
      currency,
      prices,
      payload,
    });

    // If successful, send success message
    if (response.data.ok) {
      res.status(200).json({ message: 'Invoice sent successfully.' });
    } else {
      // If Telegram API returns an error
      res.status(500).json({ error: response.data.description });
    }
  } catch (error) {
    // Handle request errors
    console.error('Error sending invoice:', error.message);
    res.status(500).json({ error: 'Failed to send invoice.' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
