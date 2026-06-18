/**
 * DevTools Pro Backend Server
 * 
 * Replaces Google Sheets with Supabase PostgreSQL.
 * Automatically attaches Google Meet links and setup notes.
 * 
 * Deploy to: Render.com (free), Railway, or any Node.js host
 */

require('dotenv').config();

// Polyfill fetch for Node 18 DNS issues on some Linux systems
globalThis.fetch = require('cross-fetch');

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { initDB, addSubmission, getAllSubmissions, getSubmissionByUTR, getStats } = require('./db');
const { generateSetupMessage, generateQuickReply } = require('./meet-service');
const { createPaymentRecord, submitUTR, getPaymentStatus, verifyPayment, getPendingPayments, getUTRConfidence } = require('./payment-verify');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ───
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Initialize database on startup
initDB().catch(err => {
  console.error('Failed to connect to Supabase:', err.message);
  process.exit(1);
});

// ─── Health Check ───
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'DevTools Pro Backend',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// ─── POST /api/submit ───
// Main endpoint: receives user form data, stores in DB, returns Meet link + message
app.post('/api/submit', async (req, res) => {
  try {
    const { firstName, lastName, email, selectedPlan, utrId, submissionTimestamp } = req.body;

    // Validate required fields
    const requiredFields = { firstName, lastName, email, selectedPlan, utrId };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (!value || !value.toString().trim()) {
        return res.status(400).json({
          status: 'error',
          message: `Missing required field: ${field}`
        });
      }
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid email format'
      });
    }

    // Generate Meet link and setup message
    const userData = { firstName, lastName, email, selectedPlan, utrId };
    const setupInfo = generateSetupMessage(userData);

    // Prepare submission record
    const submission = {
      id: uuidv4(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim(),
      selectedPlan,
      utrId: utrId.trim(),
      submissionTimestamp: submissionTimestamp || new Date().toISOString(),
      meetLink: setupInfo.meetLink,
      notes: setupInfo.autoReplyNote
    };

    // Save to database
    const result = await addSubmission(submission);

    if (!result.success) {
      if (result.error === 'duplicate') {
        return res.status(409).json({
          status: 'duplicate',
          message: 'This UTR/Transaction ID has already been submitted'
        });
      }
      return res.status(500).json({
        status: 'error',
        message: result.message
      });
    }

    // Build the WhatsApp redirect URL with Meet link included
    const whatsappNumber = process.env.WHATSAPP_NUMBER || '919019879108';
    const quickReply = generateQuickReply(userData, setupInfo.meetLink);
    const whatsappUrl = `https://api.whatsapp.com/send?phone=${whatsappNumber}&text=${encodeURIComponent(setupInfo.whatsappMessage)}`;

    // Return success with Meet link and WhatsApp URL
    res.status(201).json({
      status: 'success',
      message: 'Submission saved successfully',
      data: {
        id: submission.id,
        meetLink: setupInfo.meetLink,
        setupNote: setupInfo.autoReplyNote,
        whatsappUrl,
        whatsappMessage: setupInfo.whatsappMessage,
        quickReply
      }
    });

    console.log(`✅ New submission: ${firstName} ${lastName} | Plan: ${selectedPlan} | Meet: ${setupInfo.meetLink}`);

  } catch (error) {
    console.error('❌ Submit error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Internal server error'
    });
  }
});

// ─── GET /api/submissions ───
// Admin endpoint: get all submissions
app.get('/api/submissions', async (req, res) => {
  try {
    const submissions = await getAllSubmissions();
    res.json({
      status: 'success',
      count: submissions.length,
      data: submissions
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── GET /api/check-utr/:utrId ───
// Check if a UTR already exists
app.get('/api/check-utr/:utrId', async (req, res) => {
  try {
    const existing = await getSubmissionByUTR(req.params.utrId);
    res.json({
      exists: !!existing,
      status: existing ? existing.status : null
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ─── GET /api/stats ───
// Get submission statistics
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await getStats();
    res.json({ status: 'success', data: stats });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ═══════════════════════════════════════════
// PAYMENT VERIFICATION ENDPOINTS
// ═══════════════════════════════════════════

// ─── POST /api/payment/create ───
// Create a payment session when user selects a plan
app.post('/api/payment/create', async (req, res) => {
  try {
    const { amount, plan } = req.body;
    if (!amount || !plan) {
      return res.status(400).json({ status: 'error', message: 'Amount and plan are required' });
    }
    const result = await createPaymentRecord({ amount, plan, upiId: 'devtoolpro@ybl' });
    if (!result.success) {
      return res.status(500).json({ status: 'error', message: result.message });
    }
    res.status(201).json({
      status: 'success',
      paymentId: result.paymentId,
      upiId: 'devtoolpro@ybl',
      amount,
      plan
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /api/payment/submit-utr ───
// User submits UTR after making payment
app.post('/api/payment/submit-utr', async (req, res) => {
  try {
    const { paymentId, utrId } = req.body;
    if (!paymentId || !utrId) {
      return res.status(400).json({ status: 'error', message: 'Payment ID and UTR are required' });
    }

    const result = await submitUTR(paymentId, utrId);
    if (!result.success) {
      return res.status(400).json({ status: 'error', message: result.message });
    }

    // Calculate UTR confidence score
    const confidence = getUTRConfidence(utrId.trim());

    // If confidence is very high (standard 12-digit UTR), auto-verify after short delay
    if (confidence >= 70) {
      // Auto-verify high-confidence UTRs after 5 seconds (simulates verification)
      setTimeout(async () => {
        try {
          await verifyPayment(paymentId, process.env.ADMIN_KEY);
          console.log(`✅ Auto-verified payment ${paymentId} (UTR: ${utrId}, confidence: ${confidence})`);
        } catch (e) {
          console.error('Auto-verify failed:', e.message);
        }
      }, 5000);
    }

    res.json({
      status: 'success',
      message: 'UTR submitted — verifying payment',
      paymentStatus: 'awaiting_verification',
      confidence
    });

    console.log(`💰 UTR submitted: ${utrId} | Payment: ${paymentId} | Confidence: ${confidence}`);
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/payment/status/:paymentId ───
// Frontend polls this to check if payment is verified
app.get('/api/payment/status/:paymentId', async (req, res) => {
  try {
    const result = await getPaymentStatus(req.params.paymentId);
    if (!result.found) {
      return res.status(404).json({ status: 'error', message: 'Payment not found' });
    }
    res.json({ status: 'success', data: result });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── POST /api/payment/verify/:paymentId ───
// Admin: manually verify a payment
app.post('/api/payment/verify/:paymentId', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.body.adminKey;
    const result = await verifyPayment(req.params.paymentId, adminKey);
    if (!result.success) {
      return res.status(result.message === 'Unauthorized' ? 401 : 400).json({
        status: 'error',
        message: result.message
      });
    }
    res.json({ status: 'success', message: 'Payment verified', data: result.record });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── GET /api/payment/pending ───
// Admin: get all payments waiting for verification
app.get('/api/payment/pending', async (req, res) => {
  try {
    const adminKey = req.headers['x-admin-key'] || req.query.key;
    const result = await getPendingPayments(adminKey);
    if (!result.success) {
      return res.status(401).json({ status: 'error', message: result.message });
    }
    res.json({ status: 'success', count: result.payments.length, data: result.payments });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Internal error' });
  }
});

// ─── Start Server ───
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║   DevTools Pro Backend                       ║
║   Running on port ${PORT}                        ║
║   Database: Supabase PostgreSQL              ║
║   Meet links: Configured ✓                   ║
╚══════════════════════════════════════════════╝
  `);
});

module.exports = app;
