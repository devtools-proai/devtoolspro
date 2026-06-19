// ─── CONFIGURATION ───
const WHATSAPP_NUMBER = '919019879108';
const API_BASE = 'https://devtools-pro.onrender.com';
const API_ENDPOINT = `${API_BASE}/api/submit`;

// ─── AUTH SESSION ───
function getToken() { return localStorage.getItem('dt_token'); }
function setToken(token) { localStorage.setItem('dt_token', token); }
function getStoredUser() { try { return JSON.parse(localStorage.getItem('dt_user')); } catch { return null; } }
function setStoredUser(user) { localStorage.setItem('dt_user', JSON.stringify(user)); }
let currentUser = null;

// ─── BACKEND API SUBMISSION ───
async function submitToBackend(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const data = await response.json();

    if (response.ok && data.status === 'success') {
      console.log('✅ Backend submission successful');
      return { success: true, data: data.data };
    } else if (data.status === 'duplicate') {
      console.warn('⚠️ Duplicate UTR detected');
      return { success: false, error: 'duplicate', message: data.message };
    } else {
      console.error('❌ Backend submission failed:', data.message);
      return { success: false, error: 'failed', message: data.message };
    }
  } catch (error) {
    console.error('❌ Backend submission error:', error.message);
    return { success: false, error: 'network', message: 'Could not reach server' };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── PAYMENT VERIFICATION API ───
async function createPayment(amount, plan) {
  try {
    const response = await fetch(`${API_BASE}/api/payment/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, plan })
    });
    const data = await response.json();
    if (data.status === 'success') return { success: true, paymentId: data.paymentId };
    return { success: false };
  } catch (e) {
    console.error('Create payment error:', e);
    return { success: false };
  }
}

async function submitPaymentUTR(paymentId, utrId) {
  try {
    const response = await fetch(`${API_BASE}/api/payment/submit-utr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentId, utrId })
    });
    return await response.json();
  } catch (e) {
    console.error('Submit UTR error:', e);
    return { status: 'error', message: 'Network error' };
  }
}

async function checkPaymentStatus(paymentId) {
  try {
    const response = await fetch(`${API_BASE}/api/payment/status/${paymentId}`);
    const data = await response.json();
    if (data.status === 'success') return data.data;
    return { status: 'unknown' };
  } catch (e) {
    return { status: 'unknown' };
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const step1 = document.getElementById('step-1');
  const step2 = document.getElementById('step-2');
  const step3 = document.getElementById('step-3');
  const stepSuccess = document.getElementById('step-success');
  const form = document.getElementById('signup-form');
  const header = document.querySelector('header');
  const stepInds = [document.getElementById('step-ind-1'), document.getElementById('step-ind-2'), document.getElementById('step-ind-3')];
  const stepLines = [document.getElementById('step-line-1'), document.getElementById('step-line-2')];
  const signinGate = document.getElementById('signin-gate');
  const signedinBar = document.getElementById('signedin-bar');
  const stepIndicators = document.querySelector('.flex.items-center.justify-center.gap-2.mb-8');

  let selectedPlan = '';
  let selectedAmount = 0;
  let currentPaymentId = null;
  let verificationPollTimer = null;

  // ─── AUTH GATE: Check if user is signed in ───
  function checkAuthState() {
    const token = getToken();
    const user = getStoredUser();

    if (token && user) {
      currentUser = user;
      // Hide gate, show checkout
      if (signinGate) signinGate.classList.add('hidden');
      if (signedinBar) {
        signedinBar.classList.remove('hidden');
        document.getElementById('signup-user-avatar').src = user.picture || '';
        document.getElementById('signup-user-name').textContent = user.name || '';
        document.getElementById('signup-user-email').textContent = user.email || '';
      }
      if (step1) step1.classList.remove('hidden');
      if (stepIndicators) stepIndicators.classList.remove('hidden');
    } else {
      // Show gate, hide checkout
      if (signinGate) signinGate.classList.remove('hidden');
      if (signedinBar) signedinBar.classList.add('hidden');
      if (step1) step1.classList.add('hidden');
      if (stepIndicators) stepIndicators.classList.add('hidden');
    }
  }

  // Initialize auth state
  checkAuthState();

  // Google Sign-In button in signup section
  const signupGoogleBtn = document.getElementById('signup-google-btn');
  if (signupGoogleBtn) {
    signupGoogleBtn.addEventListener('click', async () => {
      try {
        const r = await fetch(`${API_BASE}/auth/google-client-id`);
        const data = await r.json();
        const clientId = data.clientId;

        if (typeof google === 'undefined' || !google.accounts) {
          alert('Google Sign-In failed to load. Please disable ad-blockers and refresh.');
          return;
        }

        google.accounts.id.initialize({
          client_id: clientId,
          callback: async (response) => {
            // Remove popup if it exists
            const popup = document.getElementById('google-popup-overlay');
            if (popup) popup.remove();

            try {
              const res = await fetch(`${API_BASE}/auth/google`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken: response.credential })
              });
              const result = await res.json();
              if (result.status === 'success') {
                setToken(result.token);
                setStoredUser(result.user);
                currentUser = result.user;
                checkAuthState();
              } else {
                alert('Sign-in failed: ' + (result.message || 'Unknown error'));
              }
            } catch (e) {
              console.error('Sign-in error:', e);
              alert('Connection error. Please try again.');
            }
          }
        });

        // Show Google's rendered button in a centered overlay
        const overlay = document.createElement('div');
        overlay.id = 'google-popup-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1f2937;padding:2rem;border-radius:1rem;text-align:center;border:1px solid #374151;';
        box.innerHTML = '<p style="color:#9ca3af;font-size:0.85rem;margin-bottom:1rem;">Select your Google account</p>';
        const btnContainer = document.createElement('div');
        box.appendChild(btnContainer);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        google.accounts.id.renderButton(btnContainer, {
          theme: 'filled_blue',
          size: 'large',
          width: 280,
          text: 'signin_with'
        });

        // Close on overlay click
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
        document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } });

      } catch (e) {
        console.error('Failed to initialize Google Sign-In:', e);
        alert('Could not connect to server. Please try again.');
      }
    });
  }

  function showStep(num) {
    [step1, step2, step3, stepSuccess].forEach(el => { if (el) el.classList.add('hidden'); });
    if (num === 1 && step1) step1.classList.remove('hidden');
    if (num === 2 && step2) step2.classList.remove('hidden');
    if (num === 3 && step3) step3.classList.remove('hidden');
    if (num === 4 && stepSuccess) stepSuccess.classList.remove('hidden');
    stepInds.forEach((ind, i) => {
      if (!ind) return;
      if (i < num) { ind.classList.remove('bg-gray-700', 'text-gray-400'); ind.classList.add('bg-indigo-600', 'text-white'); }
      else { ind.classList.remove('bg-indigo-600', 'text-white'); ind.classList.add('bg-gray-700', 'text-gray-400'); }
    });
    stepLines.forEach((line, i) => {
      if (!line) return;
      line.classList.toggle('bg-indigo-600', i < num - 1);
      line.classList.toggle('bg-gray-700', i >= num - 1);
    });
  }

  // ─── BILLING BREAKDOWN CALCULATOR ───
  function updateBillingBreakdown(monthlyAmount) {
    const now = new Date();
    const today = now.getDate();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();
    const remainingDays = daysInMonth - today + 1; // including today

    // Prorated amount = (remaining days / total days) * monthly price
    const proratedAmount = Math.round((remainingDays / daysInMonth) * monthlyAmount);

    // Format dates
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const todayStr = `${today} ${monthNames[currentMonth]}`;
    const nextMonth = currentMonth === 11 ? 0 : currentMonth + 1;
    const nextMonthYear = currentMonth === 11 ? currentYear + 1 : currentYear;
    const nextMonthStr = `1 ${monthNames[nextMonth]} ${nextMonthYear}`;

    // Update DOM
    const startDateEl = document.getElementById('billing-start-date');
    const proratedEl = document.getElementById('billing-prorated-amount');
    const nextMonthEl = document.getElementById('billing-next-month');
    const fullAmountEl = document.getElementById('billing-full-amount');
    const paymentAmountEl = document.getElementById('payment-amount');

    if (startDateEl) startDateEl.textContent = todayStr;
    if (proratedEl) proratedEl.textContent = `₹${proratedAmount.toLocaleString('en-IN')} · ${remainingDays} days`;
    if (nextMonthEl) nextMonthEl.textContent = nextMonthStr;
    if (fullAmountEl) fullAmountEl.textContent = `₹${monthlyAmount.toLocaleString('en-IN')}/mo`;

    // Update the main payment amount to show prorated price
    if (paymentAmountEl) {
      paymentAmountEl.innerHTML = `Pay Today: <span class="text-white">₹${proratedAmount.toLocaleString('en-IN')}</span>`;
    }
  }

  // ─── STEP 1 → STEP 2 ───
  const toStep2Btn = document.getElementById('to-step-2');
  if (toStep2Btn) {
    toStep2Btn.addEventListener('click', async () => {
      const radio = document.querySelector('input[name="selectedPlan"]:checked');
      const planError = document.getElementById('plan-error');
      if (!radio) { if (planError) planError.classList.remove('hidden'); return; }
      if (planError) planError.classList.add('hidden');
      selectedPlan = radio.value;
      selectedAmount = Number(radio.dataset.amount);

      // Calculate prorated amount for today
      const now = new Date();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const remainingDays = daysInMonth - now.getDate() + 1;
      const proratedAmount = Math.round((remainingDays / daysInMonth) * selectedAmount);

      const amountEl = document.getElementById('payment-amount');
      if (amountEl) amountEl.innerHTML = `Pay Today: <span class="text-white">₹${proratedAmount.toLocaleString('en-IN')}</span>`;

      const upiString = `upi://pay?pa=devtoolpro@ybl&pn=DevTools%20Pro&am=${proratedAmount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      
      // Set app-specific deep links
      const phonePeLink = document.getElementById('phonepe-link');
      const gpayLink = document.getElementById('gpay-link');
      
      const phonepeUrl = `phonepe://pay?pa=devtoolpro@ybl&pn=DevTools%20Pro&am=${proratedAmount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      const gpayUrl = `tez://upi/pay?pa=devtoolpro@ybl&pn=DevTools%20Pro&am=${proratedAmount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      
      if (phonePeLink) phonePeLink.href = phonepeUrl;
      if (gpayLink) gpayLink.href = gpayUrl;

      // Render QR
      const qrContainer = document.getElementById('qr-code-container');
      if (qrContainer && typeof QRCode !== 'undefined') {
        qrContainer.innerHTML = '';
        new QRCode(qrContainer, {
          text: upiString,
          width: 200,
          height: 200,
          colorDark: '#000000',
          colorLight: '#ffffff',
          correctLevel: QRCode.CorrectLevel.M
        });
      }

      // Create payment session in backend
      const paymentResult = await createPayment(selectedAmount, selectedPlan);
      if (paymentResult.success) {
        currentPaymentId = paymentResult.paymentId;
        console.log('Payment session created:', currentPaymentId);
      }

      // Calculate and display prorated billing breakdown
      updateBillingBreakdown(selectedAmount);

      showStep(2);
    });
  }

  // ─── STEP 2 → STEP 3 ───
  const toStep3Btn = document.getElementById('to-step-3');
  if (toStep3Btn) {
    toStep3Btn.addEventListener('click', () => {
      showStep(3);
      const display = document.getElementById('selected-plan-display');
      if (display) display.textContent = selectedPlan;
    });
  }

  // ─── BACK BUTTONS ───
  const backTo1 = document.getElementById('back-to-1');
  const backTo2 = document.getElementById('back-to-2');
  if (backTo1) backTo1.addEventListener('click', () => { stopVerificationPoll(); showStep(1); });
  if (backTo2) backTo2.addEventListener('click', () => { stopVerificationPoll(); showStep(2); });

  // ─── COPY UPI ───
  const copyBtn = document.getElementById('copy-upi');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText('devtoolpro@ybl');
      copyBtn.innerHTML = '<svg class="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>';
      setTimeout(() => { copyBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>'; }, 2000);
    });
  }

  // ─── VALIDATION ───
  function validateEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function showError(field, msg) {
    const el = document.getElementById(`${field.id}-error`);
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
    field.classList.add('border-red-500'); field.classList.remove('border-gray-700');
  }
  function clearError(field) {
    const el = document.getElementById(`${field.id}-error`);
    if (el) { el.textContent = ''; el.classList.add('hidden'); }
    field.classList.remove('border-red-500'); field.classList.add('border-gray-700');
  }
  function validateField(field) {
    const v = field.value.trim();
    switch (field.id) {
      case 'firstName': if (!v) { showError(field, 'Required'); return false; } break;
      case 'lastName': if (!v) { showError(field, 'Required'); return false; } break;
      case 'emailId': if (!v) { showError(field, 'Required'); return false; } if (!validateEmail(v)) { showError(field, 'Invalid email'); return false; } break;
      case 'utrId': if (!v) { showError(field, 'Required'); return false; } if (v.length < 6) { showError(field, 'Enter valid UTR (min 6 chars)'); return false; } if (!/^[a-zA-Z0-9\-]+$/.test(v)) { showError(field, 'Only letters and numbers allowed'); return false; } break;
    }
    clearError(field); return true;
  }

  // ─── PAYMENT VERIFICATION POLLING ───
  function startVerificationPoll(paymentId, onVerified) {
    const statusEl = document.getElementById('verification-status');
    let pollCount = 0;
    const maxPolls = 60; // 3 minutes (every 3 seconds)

    if (statusEl) {
      statusEl.classList.remove('hidden');
      statusEl.innerHTML = `
        <div class="flex items-center gap-2 text-amber-300">
          <svg class="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
          </svg>
          <span>Verifying payment...</span>
        </div>
      `;
    }

    verificationPollTimer = setInterval(async () => {
      pollCount++;
      const result = await checkPaymentStatus(paymentId);

      if (result.status === 'verified') {
        stopVerificationPoll();
        if (statusEl) {
          statusEl.innerHTML = `
            <div class="flex items-center gap-2 text-emerald-400">
              <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
              <span>Payment verified! ✓</span>
            </div>
          `;
        }
        if (onVerified) onVerified();
      } else if (result.status === 'expired') {
        stopVerificationPoll();
        if (statusEl) {
          statusEl.innerHTML = `<div class="text-red-400 text-sm">Payment session expired. Please try again.</div>`;
        }
      } else if (pollCount >= maxPolls) {
        stopVerificationPoll();
        // Still allow submission even if verification times out
        if (statusEl) {
          statusEl.innerHTML = `<div class="text-gray-400 text-sm">Verification taking longer than expected. You can still submit — we'll verify manually.</div>`;
        }
        if (onVerified) onVerified();
      }
    }, 3000);
  }

  function stopVerificationPoll() {
    if (verificationPollTimer) {
      clearInterval(verificationPollTimer);
      verificationPollTimer = null;
    }
  }

  // ─── FORM SUBMIT → VERIFY UTR → BACKEND + WHATSAPP WITH MEET LINK ───
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const firstName = document.getElementById('firstName');
      const lastName = document.getElementById('lastName');
      const email = document.getElementById('emailId');
      const utr = document.getElementById('utrId');
      const fields = [firstName, lastName, email, utr];
      const isValid = fields.every(f => validateField(f));

      if (isValid) {
        // Show loading state on submit button
        const submitBtn = form.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.innerHTML = '<svg class="animate-spin w-5 h-5 mr-2 inline" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg> Verifying Payment...';
        }

        // Step 1: Submit UTR to payment verification system
        if (currentPaymentId) {
          const utrResult = await submitPaymentUTR(currentPaymentId, utr.value.trim());

          if (utrResult.status === 'error') {
            showError(utr, utrResult.message || 'Invalid UTR');
            if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
            return;
          }

          // Step 2: Start polling for verification
          startVerificationPoll(currentPaymentId, async () => {
            // Payment verified (or timed out) — proceed with submission
            await completeSubmission(firstName, lastName, email, utr, submitBtn, originalBtnText);
          });
        } else {
          // No payment session (backend was unreachable earlier) — submit directly
          await completeSubmission(firstName, lastName, email, utr, submitBtn, originalBtnText);
        }
      }
    });
  }

  // Complete the submission after payment verification
  async function completeSubmission(firstName, lastName, email, utr, submitBtn, originalBtnText) {
    const payload = {
      firstName: firstName.value.trim(),
      lastName: lastName.value.trim(),
      email: email.value.trim(),
      selectedPlan: selectedPlan,
      utrId: utr.value.trim(),
      submissionTimestamp: new Date().toISOString()
    };

    // Submit to backend API
    const result = await submitToBackend(payload);

    if (result.success && result.data) {
      // Backend returned Meet link and WhatsApp message
      window.open(result.data.whatsappUrl, '_blank');
      showStep(4);

      // Update success step with Meet link info
      const successContent = document.getElementById('step-success');
      if (successContent) {
        const meetInfoEl = successContent.querySelector('.meet-link-info');
        if (meetInfoEl) {
          meetInfoEl.innerHTML = `
            <div class="mt-4 p-4 bg-indigo-500/10 border border-indigo-500/30 rounded-xl">
              <p class="text-indigo-300 font-semibold mb-2">🎥 Your Google Meet Setup Link:</p>
              <a href="${result.data.meetLink}" target="_blank" class="text-indigo-400 hover:text-indigo-300 underline break-all">${result.data.meetLink}</a>
              <p class="text-gray-400 text-sm mt-2">⏰ Our team will join within 5 minutes for your setup.</p>
            </div>
          `;
        }
      }
    } else if (result.error === 'duplicate') {
      showError(utr, 'This UTR has already been submitted');
    } else {
      // Backend unreachable — fallback to direct WhatsApp
      console.warn('Backend unavailable, falling back to direct WhatsApp');
      const message = `Hi! I've made the payment and want to set up my subscription.\n\nFirst Name: ${firstName.value.trim()}\nLast Name: ${lastName.value.trim()}\nEmail: ${email.value.trim()}\nSelected Plan: ${selectedPlan}\nUTR/Transaction ID: ${utr.value.trim()}\n\nPlease verify and schedule my 1:1 Google Meet setup. Thanks!`;
      window.open(`https://api.whatsapp.com/send?phone=${WHATSAPP_NUMBER}&text=${encodeURIComponent(message)}`, '_blank');
      showStep(4);
    }

    // Reset button
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = originalBtnText; }
  }

  // Blur validation
  ['firstName', 'lastName', 'emailId', 'utrId'].forEach(id => {
    const f = document.getElementById(id);
    if (f) { f.addEventListener('blur', () => validateField(f)); f.addEventListener('input', () => { if (f.classList.contains('border-red-500')) validateField(f); }); }
  });

  // ─── PRICING SECTION CURRENCY TOGGLE ───
  const btnUSD = document.getElementById('btn-usd');
  const btnINR = document.getElementById('btn-inr');
  const pricingCards = document.querySelectorAll('.flip-card');

  function switchCurrency(currency) {
    if (currency === 'usd') {
      if (btnUSD) { btnUSD.classList.add('bg-indigo-600', 'text-white'); btnUSD.classList.remove('text-gray-400'); }
      if (btnINR) { btnINR.classList.remove('bg-indigo-600', 'text-white'); btnINR.classList.add('text-gray-400'); }
    } else {
      if (btnINR) { btnINR.classList.add('bg-indigo-600', 'text-white'); btnINR.classList.remove('text-gray-400'); }
      if (btnUSD) { btnUSD.classList.remove('bg-indigo-600', 'text-white'); btnUSD.classList.add('text-gray-400'); }
    }
    pricingCards.forEach(card => {
      const inner = card.querySelector('.flip-card-inner');
      if (inner) inner.classList.add('flipping');
      setTimeout(() => {
        const original = card.querySelector('.original-price');
        const discounted = card.querySelector('.discounted-price');
        const symbol = currency === 'usd' ? '$' : '₹';
        if (original) original.textContent = `${symbol}${card.dataset[`${currency}Original`]}/month`;
        if (discounted) discounted.innerHTML = `${symbol}${card.dataset[`${currency}Discounted`]}<span class="text-base font-normal text-gray-400">/mo</span>`;
      }, 300);
      setTimeout(() => { if (inner) inner.classList.remove('flipping'); }, 600);
    });
  }

  if (btnUSD) btnUSD.addEventListener('click', () => switchCurrency('usd'));
  if (btnINR) btnINR.addEventListener('click', () => switchCurrency('inr'));

  // ─── HEADER SCROLL ───
  window.addEventListener('scroll', () => {
    if (header) header.style.background = window.scrollY > 50 ? 'rgba(3,7,18,0.95)' : 'rgba(17,24,39,0.8)';
  });

  // ─── FAQ ACCORDION ───
  document.querySelectorAll('.faq-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const answer = btn.nextElementSibling;
      const icon = btn.querySelector('.faq-icon');
      const isOpen = !answer.classList.contains('hidden');
      document.querySelectorAll('.faq-answer').forEach(a => a.classList.add('hidden'));
      document.querySelectorAll('.faq-icon').forEach(i => i.classList.remove('rotate-180'));
      if (!isOpen) { answer.classList.remove('hidden'); if (icon) icon.classList.add('rotate-180'); }
    });
  });

  // ─── SCROLL REVEAL ───
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => { if (entry.isIntersecting) { entry.target.style.opacity = '1'; entry.target.style.transform = 'translateY(0)'; } });
  }, { threshold: 0.1 });
  document.querySelectorAll('#pricing .flip-card').forEach(el => {
    el.style.opacity = '0'; el.style.transform = 'translateY(20px)'; el.style.transition = 'opacity 0.6s ease, transform 0.6s ease'; observer.observe(el);
  });
});

// ═══════════════════════════════════════════
// DYNAMIC REVIEWS — Submit + Live Render
// ═══════════════════════════════════════════

(function() {
  const reviewForm = document.getElementById('review-form');
  const charCount = document.getElementById('reviewCharCount');
  const reviewText = document.getElementById('reviewText');
  const starRating = document.getElementById('star-rating');
  let selectedRating = 0; // Start with no stars selected

  if (!reviewForm) return;

  // Character counter
  if (reviewText && charCount) {
    reviewText.addEventListener('input', () => {
      charCount.textContent = reviewText.value.length;
    });
  }

  // Star rating interactive — starts empty
  if (starRating) {
    const stars = starRating.querySelectorAll('[data-star]');
    const ratingLabel = document.getElementById('rating-label');
    const labels = ['', 'Not great', 'Okay', 'Good', 'Great!', 'Amazing!'];

    stars.forEach(star => {
      star.addEventListener('click', () => {
        selectedRating = parseInt(star.dataset.star);
        updateStars(selectedRating);
        if (ratingLabel) { ratingLabel.textContent = labels[selectedRating]; ratingLabel.classList.remove('text-gray-500'); ratingLabel.classList.add('text-yellow-400'); }
      });
      star.addEventListener('mouseenter', () => {
        const hoverVal = parseInt(star.dataset.star);
        stars.forEach(s => {
          const sVal = parseInt(s.dataset.star);
          s.classList.toggle('text-yellow-400', sVal <= hoverVal);
          s.classList.toggle('text-gray-700', sVal > hoverVal);
          s.style.transform = sVal <= hoverVal ? 'scale(1.2)' : 'scale(1)';
        });
      });
    });
    starRating.addEventListener('mouseleave', () => {
      updateStars(selectedRating);
      stars.forEach(s => { s.style.transform = 'scale(1)'; });
    });

    function updateStars(rating) {
      stars.forEach(s => {
        const sVal = parseInt(s.dataset.star);
        s.classList.toggle('text-yellow-400', sVal <= rating);
        s.classList.toggle('text-gray-700', sVal > rating);
      });
    }
  }

  // Submit review
  reviewForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('reviewName').value.trim();
    const city = document.getElementById('reviewCity').value.trim();
    const role = document.getElementById('reviewRole').value;
    const text = reviewText.value.trim();
    const successEl = document.getElementById('review-success');
    const errorEl = document.getElementById('review-error');
    const submitBtn = document.getElementById('review-submit-btn');

    if (successEl) successEl.classList.add('hidden');
    if (errorEl) errorEl.classList.add('hidden');

    if (!name || !city || !text) {
      if (errorEl) { errorEl.textContent = 'Please fill all fields'; errorEl.classList.remove('hidden'); }
      return;
    }
    if (selectedRating === 0) {
      if (errorEl) { errorEl.textContent = 'Please select a star rating'; errorEl.classList.remove('hidden'); }
      return;
    }

    // Loading state
    if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<svg class="animate-spin w-4 h-4 mr-2 inline" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>Submitting...'; }

    try {
      const response = await fetch(`${API_BASE}/api/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, city, role, reviewText: text, rating: selectedRating })
      });
      const data = await response.json();

      if (data.status === 'success') {
        // Show glowing 3D stars burst animation
        showSuccessAnimation(selectedRating);

        reviewForm.reset();
        if (charCount) charCount.textContent = '0';
        const ratingLabel = document.getElementById('rating-label');
        if (ratingLabel) { ratingLabel.textContent = ''; ratingLabel.classList.remove('text-yellow-400'); }
        const prevRating = selectedRating;
        selectedRating = 0;
        if (starRating) {
          starRating.querySelectorAll('[data-star]').forEach(s => {
            s.classList.remove('text-yellow-400');
            s.classList.add('text-gray-700');
          });
        }
        // Inject the new review card into track 1
        injectNewReviewCard({ name, city, role, text, rating: prevRating });
      } else {
        if (errorEl) { errorEl.textContent = data.message || 'Something went wrong'; errorEl.classList.remove('hidden'); }
      }
    } catch (err) {
      if (errorEl) { errorEl.textContent = 'Could not connect to server'; errorEl.classList.remove('hidden'); }
    }

    // Reset button
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = 'Submit Review ✨'; }
  });

  // Glowing 3D stars burst animation on success — fullscreen overlay
  function showSuccessAnimation(rating) {
    // Create fullscreen overlay
    const overlay = document.createElement('div');
    overlay.className = 'review-overlay';
    overlay.id = 'review-overlay';

    const starsHtml = Array.from({ length: rating }, () => '<span>★</span>').join('');
    overlay.innerHTML = `
      <div class="review-overlay-content">
        <div class="review-stars-burst">${starsHtml}</div>
        <p class="thank-you-text">Thank you for your feedback!</p>
        <p class="text-gray-400 text-sm mt-2" style="animation: thankYouPop 0.4s ease-out 1.1s both;">Your review is now live above ↑</p>
        <button class="review-ok-btn" id="review-ok-btn">Okay</button>
      </div>
    `;

    document.body.appendChild(overlay);

    // Close on OK button click
    overlay.querySelector('#review-ok-btn').addEventListener('click', () => {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.3s ease';
      setTimeout(() => overlay.remove(), 300);
    });

    // Also close on overlay background click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.style.opacity = '0';
        overlay.style.transition = 'opacity 0.3s ease';
        setTimeout(() => overlay.remove(), 300);
      }
    });
  }

  // Inject new card into the first reviews track
  function injectNewReviewCard({ name, city, role, text, rating }) {
    const track = document.querySelector('.reviews-track .reviews-scroll');
    if (!track) return;

    const initials = name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const colors = ['from-indigo-400 to-purple-500', 'from-emerald-400 to-cyan-500', 'from-rose-400 to-pink-500', 'from-amber-400 to-orange-500', 'from-sky-400 to-blue-500'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const starsHtml = Array.from({ length: 5 }, (_, i) => i < rating ? '★' : '<span class="text-gray-600">★</span>').join('');

    const card = document.createElement('div');
    card.className = 'review-card';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.9)';
    card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    card.innerHTML = `
      <div class="flex items-center gap-3 mb-3">
        <div class="w-9 h-9 rounded-full bg-gradient-to-br ${randomColor} flex items-center justify-center text-white font-bold text-sm">${initials}</div>
        <div><p class="text-white text-sm font-semibold">${name}</p><p class="text-gray-500 text-xs">${city} · ${role}</p></div>
      </div>
      <p class="text-gray-300 text-sm leading-relaxed">${text}</p>
      <div class="flex gap-0.5 mt-2">${starsHtml}</div>
      <p class="text-[10px] text-indigo-400 mt-2">Just now ✓</p>
    `;

    // Insert at the beginning of the track
    track.insertBefore(card, track.firstChild);

    // Animate in
    requestAnimationFrame(() => {
      card.style.opacity = '1';
      card.style.transform = 'scale(1)';
    });

    // Remove the last card in this track to keep count stable
    const allCards = track.querySelectorAll('.review-card');
    if (allCards.length > 14) {
      const lastCard = allCards[allCards.length - 1];
      lastCard.style.opacity = '0';
      lastCard.style.transform = 'scale(0.8)';
      setTimeout(() => lastCard.remove(), 500);
    }
  }

  // Load dynamic reviews from backend on page load (latest user-submitted ones)
  async function loadDynamicReviews() {
    try {
      const response = await fetch(`${API_BASE}/api/reviews?limit=5`);
      const data = await response.json();
      if (data.status === 'success' && data.reviews.length > 0) {
        data.reviews.reverse().forEach(r => {
          injectNewReviewCard({ name: r.name, city: r.city, role: r.role, text: r.review_text, rating: r.rating });
        });
      }
    } catch (e) {
      // Silent fail — seed reviews still show
    }
  }

  // Seed reviews — rendered via JS so they don't appear in page source
  function renderSeedReviews() {
    const seed = [
      [
        { n: 'Arjun Kulkarni', c: 'Pune, India', r: 'Developer', t: "Honestly didn't believe it at first. Same Kiro, same models, literally half the bill. Setup call took like 8 minutes and I was done.", s: 5 },
        { n: 'Marcus Johnson', c: 'Austin, TX', r: 'Freelancer', t: "Was paying $40/mo directly. Now paying $20 for the exact same thing. Support replies on WhatsApp in minutes, not days.", s: 5 },
        { n: 'Priya Sharma', c: 'Jaipur, India', r: 'Student', t: "College student, couldn't afford full price. This saved me so much. The Meet setup was super helpful — they even helped me configure extensions.", s: 5 },
        { n: 'David Wilson', c: 'Chicago, IL', r: 'Backend Dev', t: "Switched from Cursor to Kiro through these guys. Pro Max at $50 is unreal value. Claude Opus alone is worth it.", s: 5 },
        { n: 'Rahul Verma', c: 'Lucknow, India', r: 'Developer', t: "Bhai mast hai. Paid ₹946 for Pro, got everything working in 10 min flat. No drama, no catch. Renewing again next month.", s: 5 },
        { n: 'Nisha Banerjee', c: 'Kolkata, India', r: 'Student', t: "Told my hostel roommates and now 4 of us have subscriptions lol. Way better than buying ready-made projects off Telegram.", s: 4 },
        { n: 'Saurabh Patil', c: 'Nagpur, India', r: 'Full Stack', t: "Pro+ plan. 2000 credits last the whole month even with heavy usage. Setup guy was patient, explained everything on the call.", s: 5 },
      ],
      [
        { n: 'Sneha Nair', c: 'Kochi, India', r: 'Team Lead', t: "My team of 3 switched to Pro+. Saving ₹5k+ a month combined. WhatsApp support is actually responsive unlike most services.", s: 5 },
        { n: 'James Chen', c: 'San Francisco, CA', r: 'SWE', t: "Skeptical at first but the Meet call proved it. Legit subscription, legit account. 3 months in, zero issues.", s: 5 },
        { n: 'Vikram Reddy', c: 'Warangal, India', r: 'Developer', t: "No international card issues, no GST. UPI payment, instant setup. Been looking for something like this for months.", s: 4 },
        { n: 'Ananya Trivedi', c: 'Ahmedabad, India', r: 'Freelancer', t: "Freelancer here. Claude Opus for client projects at half price? Already referred 3 friends, they signed up same day.", s: 5 },
        { n: 'Kevin Park', c: 'Seattle, WA', r: 'Startup Founder', t: "Power plan at $100 instead of $200. 10k credits, all models. My startup's dev budget literally got halved overnight.", s: 5 },
        { n: 'Manish Gupta', c: 'Bhopal, India', r: 'Student', t: "3rd year CSE. Was using free tier, Pro plan with 1000 credits changed my workflow completely. Building projects 5x faster.", s: 5 },
        { n: 'Deepak Pandey', c: 'Varanasi, India', r: 'Web Dev', t: "Only complaint? Wish I found this earlier. Wasted 3 months paying full price. Everything works exactly the same.", s: 4 },
      ],
      [
        { n: 'Ritika Singh', c: 'Chandigarh, India', r: 'Student', t: "Papa was like 'why expensive software?' Showed them this deal and they were chill. ₹946/month is pocket money for what you get.", s: 5 },
        { n: 'Aditya Shetty', c: 'Mangalore, India', r: 'Developer', t: "Using Pro+ for job and freelance both. Sonnet is insanely good for code reviews. Worth every rupee even at full price tbh.", s: 5 },
        { n: 'Sarah Lewis', c: 'Portland, OR', r: 'Full Stack', t: "Found them through a Reddit thread. Thought scam but the live setup proved it. Real dashboard, real credits, real deal.", s: 4 },
        { n: 'Karthik Deshpande', c: 'Hubli, India', r: 'Intern', t: "Senior at work recommended Kiro, found this site. ₹946 is nothing compared to what you'd waste on random Udemy courses.", s: 5 },
        { n: 'Tanvi Mehta', c: 'Surat, India', r: 'Frontend Dev', t: "The 1:1 Meet setup sold me. They screen shared and showed specs mode properly. Didn't expect that level of help at this price.", s: 5 },
        { n: 'Rohan Kapoor', c: 'Indore, India', r: 'Student', t: "Used to copy paste from ChatGPT. Kiro is different level — actually understands your codebase. At this price? Just do it bro.", s: 4 },
      ]
    ];

    const colors = ['from-orange-400 to-pink-500','from-blue-400 to-cyan-500','from-emerald-400 to-teal-500','from-violet-400 to-purple-600','from-yellow-400 to-orange-500','from-pink-400 to-rose-600','from-teal-400 to-emerald-600','from-rose-400 to-red-500','from-sky-400 to-blue-600','from-lime-400 to-green-500','from-fuchsia-400 to-pink-600','from-amber-400 to-yellow-600','from-indigo-400 to-blue-500','from-red-400 to-orange-500','from-cyan-400 to-sky-600','from-purple-400 to-violet-600','from-green-400 to-emerald-600','from-orange-400 to-red-500','from-pink-400 to-fuchsia-500','from-blue-400 to-indigo-600'];

    const tracks = [
      document.querySelector('#reviews-track-1 .reviews-scroll'),
      document.querySelector('#reviews-track-2 .reviews-scroll'),
      document.querySelector('#reviews-track-3 .reviews-scroll')
    ];

    seed.forEach((trackData, trackIdx) => {
      const track = tracks[trackIdx];
      if (!track) return;
      let html = '';
      trackData.forEach((review, i) => {
        const initials = review.n.split(' ').map(w => w[0]).join('').slice(0, 2);
        const color = colors[(trackIdx * 7 + i) % colors.length];
        const starsHtml = Array.from({ length: 5 }, (_, si) => si < review.s ? '★' : '<span class="text-gray-600">★</span>').join('');
        html += `<div class="review-card"><div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded-full bg-gradient-to-br ${color} flex items-center justify-center text-white font-bold text-sm">${initials}</div><div><p class="text-white text-sm font-semibold">${review.n}</p><p class="text-gray-500 text-xs">${review.c} · ${review.r}</p></div></div><p class="text-gray-300 text-sm leading-relaxed">${review.t}</p><div class="flex gap-0.5 mt-2">${starsHtml}</div></div>`;
      });
      // Duplicate for seamless infinite scroll
      track.innerHTML = html + html;
    });
  }

  // Render seed reviews immediately
  renderSeedReviews();

  // Load user-submitted reviews after delay
  setTimeout(loadDynamicReviews, 2000);
})();
