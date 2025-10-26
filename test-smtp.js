const nodemailer = require('nodemailer');
require('dotenv').config();

(async () => {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || 'false') === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: process.env.SMTP_USER,
      subject: 'Test OTP mail',
      text: 'This is a test message from backend.',
    });
    console.log('Sent:', info.messageId || info);
  } catch (err) {
    console.error('SMTP send error:', err);
  }
  process.exit(0);
})();