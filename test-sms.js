require('dotenv').config();
const client = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

(async () => {
  try {
    const msg = await client.messages.create({
      body: 'Test OTP: 123456',
      from: process.env.TWILIO_FROM,
      to: '+YOUR_VERIFIED_NUMBER'
    });
    console.log('SMS sent id:', msg.sid);
  } catch (err) {
    console.error('Twilio send error:', err);
  }
  process.exit(0);
})();