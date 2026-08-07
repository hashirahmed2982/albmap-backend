const nodemailer = require('nodemailer');
const env = require('../../config/env');
const { pool } = require('../../config/db');

let transporter = null;

/**
 * Lazily initialized, same "degrade instead of crash" philosophy as
 * fcm.js — a server that can't send email shouldn't be a server that
 * can't start or handle any other request. Works with Mailtrap out of
 * the box (SMTP_HOST=sandbox.smtp.mailtrap.io, SMTP_PORT=2525) for
 * development — swap to a real transactional provider (SES, Postmark,
 * SendGrid's SMTP relay, etc.) for production by changing only the env
 * vars, since this is all just standard SMTP underneath.
 */
function getTransporter() {
  if (transporter) return transporter;

  if (!env.smtp.host || !env.smtp.user || !env.smtp.password) {
    console.warn('⚠️  SMTP not configured — emails will be logged, not sent. See .env.example.');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    auth: { user: env.smtp.user, pass: env.smtp.password },
  });
  return transporter;
}

async function sendEmail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[EMAIL DISABLED] Would send "${subject}" to ${to}`);
    return { sent: false, reason: 'SMTP not configured' };
  }

  try {
    await t.sendMail({ from: env.smtp.fromAddress, to, subject, html, text });
    return { sent: true };
  } catch (err) {
    // A failed email should never fail the request that triggered it
    // (signup, business submission, etc.) — log and move on, same
    // reasoning as fcm.js's sendToTopic never throwing.
    console.error(`❌ Failed to send email "${subject}" to ${to}:`, err.message);
    return { sent: false, reason: err.message };
  }
}

const emailWrapper = (bodyHtml) => `
  <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
    <div style="display: inline-flex; align-items: center; gap: 8px; margin-bottom: 24px;">
      <div style="width: 32px; height: 32px; border-radius: 8px; background: #E31320; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; font-family: sans-serif;">A</div>
      <span style="font-weight: 700; font-size: 20px; color: #1A1D1C;">AlbMap</span>
    </div>
    ${bodyHtml}
    <p style="margin-top: 32px; font-size: 12px; color: #8A8880;">AlbMap — Discover local businesses & events in Albania.</p>
  </div>
`;

async function sendWelcomeEmail(user) {
  return sendEmail({
    to: user.email,
    subject: 'Welcome to AlbMap!',
    html: emailWrapper(`
      <h1 style="font-size: 22px; color: #1A1D1C;">Welcome, ${user.name}!</h1>
      <p style="color: #52514D; line-height: 1.6;">
        Your AlbMap account is ready. Browse local businesses and events, save your favorites,
        and — whenever you're ready — list your own business to reach people nearby.
      </p>
      <a href="${env.websiteUrl}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #E31320; color: white; text-decoration: none; border-radius: 999px; font-weight: 600;">Explore AlbMap</a>
    `),
    text: `Welcome to AlbMap, ${user.name}! Your account is ready. Visit ${env.websiteUrl} to get started.`,
  });
}

async function sendBusinessSubmittedEmail(user, business) {
  return sendEmail({
    to: user.email,
    subject: `"${business.name}" submitted for review`,
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Thanks for submitting your business</h1>
      <p style="color: #52514D; line-height: 1.6;">
        "<strong>${business.name}</strong>" has been submitted and is now pending review by an
        AlbMap admin. Most listings are reviewed within 1-2 business days — we'll email you again
        as soon as a decision is made.
      </p>
    `),
    text: `"${business.name}" has been submitted and is pending admin review.`,
  });
}

/**
 * Notifies every admin (or a single configured address, if
 * ADMIN_NOTIFICATION_EMAIL is set) that a new business is waiting for
 * review — otherwise the only way an admin would know is by manually
 * checking the pending queue.
 */
async function sendAdminNewBusinessNotification(business, owner) {
  let recipients;
  if (env.smtp.adminNotificationEmail) {
    recipients = [env.smtp.adminNotificationEmail];
  } else {
    const [admins] = await pool.query("SELECT email FROM users WHERE role = 'admin'");
    recipients = admins.map((a) => a.email);
  }
  if (recipients.length === 0) return { sent: false, reason: 'No admin recipients configured' };

  return sendEmail({
    to: recipients.join(','),
    subject: `New business pending review: ${business.name}`,
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">New business submitted</h1>
      <p style="color: #52514D; line-height: 1.6;">
        <strong>${business.name}</strong> (${business.category}) was just submitted by
        ${owner.name} (${owner.email}) and is waiting for review.
      </p>
      <a href="${env.websiteUrl.replace(':3001', ':3000')}/businesses" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #E31320; color: white; text-decoration: none; border-radius: 999px; font-weight: 600;">Review in Admin Portal</a>
    `),
    text: `New business "${business.name}" submitted by ${owner.name} (${owner.email}), pending review.`,
  });
}

async function sendPasswordResetEmail(user, rawToken) {
  const resetLink = `${env.websiteUrl}/reset-password?token=${rawToken}`;
  return sendEmail({
    to: user.email,
    subject: 'Reset your AlbMap password',
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Reset your password</h1>
      <p style="color: #52514D; line-height: 1.6;">
        We received a request to reset your AlbMap password. This link expires in 1 hour.
        If you didn't request this, you can safely ignore this email.
      </p>
      <a href="${resetLink}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #E31320; color: white; text-decoration: none; border-radius: 999px; font-weight: 600;">Reset Password</a>
    `),
    text: `Reset your password: ${resetLink} (expires in 1 hour)`,
  });
}

async function sendContactFormEmail({ name, email, inquiryType, message }) {
  const recipient = env.smtp.adminNotificationEmail;
  if (!recipient) {
    console.warn('⚠️  ADMIN_NOTIFICATION_EMAIL not set — contact form submissions have nowhere to go.');
    return { sent: false, reason: 'No recipient configured' };
  }
  return sendEmail({
    to: recipient,
    subject: `[Contact — ${inquiryType}] Message from ${name}`,
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">New contact form submission</h1>
      <p style="color: #52514D;"><strong>From:</strong> ${name} (${email})</p>
      <p style="color: #52514D;"><strong>Type:</strong> ${inquiryType}</p>
      <p style="color: #52514D; line-height: 1.6; white-space: pre-wrap;">${message}</p>
    `),
    text: `From: ${name} (${email})\nType: ${inquiryType}\n\n${message}`,
  });
}

module.exports = {
  sendWelcomeEmail,
  sendBusinessSubmittedEmail,
  sendAdminNewBusinessNotification,
  sendPasswordResetEmail,
  sendContactFormEmail,
};
