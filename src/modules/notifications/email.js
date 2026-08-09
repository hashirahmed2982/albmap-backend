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

/**
 * The code is deliberately also in the subject line (not just the body) —
 * two reasons: it lets someone confirm the code from a notification
 * preview without opening the email, and it means this code shows up for
 * free in sendEmail's "[EMAIL DISABLED] Would send ..." console fallback
 * when SMTP isn't configured, so local/dev testing doesn't need any
 * separate logging.
 */
async function sendSignupOtpEmail(email, name, otp) {
  return sendEmail({
    to: email,
    subject: `${otp} is your AlbMap verification code`,
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Verify your email</h1>
      <p style="color: #52514D; line-height: 1.6;">
        Hi ${name}, enter this code to finish creating your AlbMap account. It expires in 10 minutes.
      </p>
      <p style="font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #1A1D1C; margin: 24px 0;">${otp}</p>
      <p style="color: #8A8880; font-size: 13px;">
        If you didn't try to sign up for AlbMap, you can safely ignore this email — no account has
        been created yet.
      </p>
    `),
    text: `Your AlbMap verification code is ${otp}. It expires in 10 minutes.`,
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
 * The four business-lifecycle emails below (approved/rejected/
 * deactivated/reactivated) are the actual notification an owner gets for
 * each admin decision — before this, admin.service.js only ever recorded
 * an in-app notification + a mobile push (see notification.service.js's
 * notifyBusinessStatusChange), which a business owner who primarily uses
 * the website and doesn't have the app installed would simply never see.
 * Fire-and-forget from the caller, same as every other email here —
 * sendEmail() already never throws.
 */
async function sendBusinessApprovedEmail(user, business) {
  const dashboardLink = `${env.websiteUrl}/dashboard`;
  return sendEmail({
    to: user.email,
    subject: `"${business.name}" is now live on AlbMap! 🎉`,
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Your business was approved</h1>
      <p style="color: #52514D; line-height: 1.6;">
        "<strong>${business.name}</strong>" has been approved and is now visible to everyone on
        AlbMap.
      </p>
      <a href="${dashboardLink}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #E31320; color: white; text-decoration: none; border-radius: 999px; font-weight: 600;">View my businesses</a>
    `),
    text: `"${business.name}" has been approved and is now live on AlbMap. ${dashboardLink}`,
  });
}

async function sendBusinessRejectedEmail(user, business, reason) {
  const dashboardLink = `${env.websiteUrl}/dashboard`;
  return sendEmail({
    to: user.email,
    subject: `Update on "${business.name}"`,
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Your submission wasn't approved</h1>
      <p style="color: #52514D; line-height: 1.6;">
        "<strong>${business.name}</strong>" was not approved by an AlbMap admin.
        ${reason ? `<br /><br /><strong>Reason:</strong> ${reason}` : ''}
      </p>
      <p style="color: #52514D; line-height: 1.6;">
        You can edit the listing and resubmit it for review at any time.
      </p>
      <a href="${dashboardLink}" style="display: inline-block; margin-top: 16px; padding: 12px 24px; background: #E31320; color: white; text-decoration: none; border-radius: 999px; font-weight: 600;">Edit and resubmit</a>
    `),
    text: `"${business.name}" was not approved.${reason ? ` Reason: ${reason}` : ''} Edit and resubmit at ${dashboardLink}`,
  });
}

/**
 * `reason` is mandatory at the call site (admin.service.js's
 * deactivateBusiness rejects a deactivation with no reason before this
 * is ever reached), unlike sendBusinessRejectedEmail's optional one —
 * kept as a plain string param rather than defaulting/guarding here so
 * a future caller can't silently regress back to sending a reason-less
 * deactivation email.
 */
async function sendBusinessDeactivatedEmail(user, business, reason) {
  return sendEmail({
    to: user.email,
    subject: `"${business.name}" has been deactivated`,
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Your listing was deactivated</h1>
      <p style="color: #52514D; line-height: 1.6;">
        "<strong>${business.name}</strong>" has been deactivated by an AlbMap admin and is no
        longer visible on the map or in search.
        <br /><br /><strong>Reason:</strong> ${reason}
      </p>
      <p style="color: #52514D; line-height: 1.6;">
        Your listing itself hasn't been deleted — contact AlbMap support if you believe this was
        a mistake.
      </p>
    `),
    text: `"${business.name}" has been deactivated by an admin and is no longer publicly visible. Reason: ${reason}`,
  });
}

async function sendBusinessReactivatedEmail(user, business) {
  return sendEmail({
    to: user.email,
    subject: `"${business.name}" is active again`,
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Your listing was reactivated</h1>
      <p style="color: #52514D; line-height: 1.6;">
        "<strong>${business.name}</strong>" has been reactivated and is visible on AlbMap again.
      </p>
    `),
    text: `"${business.name}" has been reactivated and is visible on AlbMap again.`,
  });
}

/**
 * A banned user has no dashboard/account page left to explain this on —
 * this email and the same-worded message on their next login attempt
 * (see auth.service.js's deactivatedAccountMessage) are the only two
 * places they'll ever see why. `reason` is mandatory at the call site
 * (admin.service.js's setUserActive), same reasoning as
 * sendBusinessDeactivatedEmail above.
 */
async function sendUserBannedEmail(user, reason) {
  return sendEmail({
    to: user.email,
    subject: 'Your AlbMap account has been deactivated',
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Your account was deactivated</h1>
      <p style="color: #52514D; line-height: 1.6;">
        An AlbMap admin has deactivated your account. You will not be able to log in until it's
        reactivated.
        <br /><br /><strong>Reason:</strong> ${reason}
      </p>
      <p style="color: #52514D; line-height: 1.6;">
        Contact AlbMap support if you believe this was a mistake.
      </p>
    `),
    text: `Your AlbMap account has been deactivated. Reason: ${reason}`,
  });
}

async function sendUserReactivatedEmail(user) {
  return sendEmail({
    to: user.email,
    subject: 'Your AlbMap account has been reactivated',
    html: emailWrapper(`
      <h1 style="font-size: 20px; color: #1A1D1C;">Your account was reactivated</h1>
      <p style="color: #52514D; line-height: 1.6;">
        An AlbMap admin has reactivated your account — you can log in again.
      </p>
    `),
    text: `Your AlbMap account has been reactivated. You can log in again.`,
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
  sendSignupOtpEmail,
  sendBusinessSubmittedEmail,
  sendBusinessApprovedEmail,
  sendBusinessRejectedEmail,
  sendBusinessDeactivatedEmail,
  sendBusinessReactivatedEmail,
  sendUserBannedEmail,
  sendUserReactivatedEmail,
  sendAdminNewBusinessNotification,
  sendPasswordResetEmail,
  sendContactFormEmail,
};
