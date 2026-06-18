// ─── CONFIGURATION ───
const WHATSAPP_NUMBER = '919019879108';
const API_BASE = 'https://devtools-pro.onrender.com';
const API_ENDPOINT = `${API_BASE}/api/submit`;

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

  let selectedPlan = '';
  let selectedAmount = 0;
  let currentPaymentId = null;
  let verificationPollTimer = null;

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

      const amountEl = document.getElementById('payment-amount');
      if (amountEl) amountEl.textContent = 'Amount: ₹' + selectedAmount.toLocaleString('en-IN');

      const upiString = `upi://pay?pa=devtoolpro@ybl&pn=DevTools%20Pro&am=${selectedAmount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      
      // Set app-specific deep links
      const phonePeLink = document.getElementById('phonepe-link');
      const gpayLink = document.getElementById('gpay-link');
      
      const phonepeUrl = `phonepe://pay?pa=devtoolpro@ybl&pn=DevTools%20Pro&am=${selectedAmount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      const gpayUrl = `tez://upi/pay?pa=devtoolpro@ybl&pn=DevTools%20Pro&am=${selectedAmount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      
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
  let selectedRating = 5;

  if (!reviewForm) return;

  // Character counter
  if (reviewText && charCount) {
    reviewText.addEventListener('input', () => {
      charCount.textContent = reviewText.value.length;
    });
  }

  // Star rating interactive
  if (starRating) {
    const stars = starRating.querySelectorAll('[data-star]');
    stars.forEach(star => {
      star.addEventListener('click', () => {
        selectedRating = parseInt(star.dataset.star);
        stars.forEach(s => {
          s.classList.toggle('text-yellow-400', parseInt(s.dataset.star) <= selectedRating);
          s.classList.toggle('text-gray-600', parseInt(s.dataset.star) > selectedRating);
        });
      });
      star.addEventListener('mouseenter', () => {
        const hoverVal = parseInt(star.dataset.star);
        stars.forEach(s => {
          s.classList.toggle('text-yellow-400', parseInt(s.dataset.star) <= hoverVal);
          s.classList.toggle('text-gray-600', parseInt(s.dataset.star) > hoverVal);
        });
      });
    });
    starRating.addEventListener('mouseleave', () => {
      stars.forEach(s => {
        s.classList.toggle('text-yellow-400', parseInt(s.dataset.star) <= selectedRating);
        s.classList.toggle('text-gray-600', parseInt(s.dataset.star) > selectedRating);
      });
    });
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

    if (successEl) successEl.classList.add('hidden');
    if (errorEl) errorEl.classList.add('hidden');

    if (!name || !city || !text) {
      if (errorEl) { errorEl.textContent = 'Please fill all fields'; errorEl.classList.remove('hidden'); }
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/api/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, city, role, reviewText: text, rating: selectedRating })
      });
      const data = await response.json();

      if (data.status === 'success') {
        if (successEl) successEl.classList.remove('hidden');
        reviewForm.reset();
        if (charCount) charCount.textContent = '0';
        selectedRating = 5;
        if (starRating) {
          starRating.querySelectorAll('[data-star]').forEach(s => s.classList.add('text-yellow-400'));
          starRating.querySelectorAll('[data-star]').forEach(s => s.classList.remove('text-gray-600'));
        }
        // Inject the new review card into track 1
        injectNewReviewCard({ name, city, role, text, rating: selectedRating });
      } else {
        if (errorEl) { errorEl.textContent = data.message || 'Something went wrong'; errorEl.classList.remove('hidden'); }
      }
    } catch (err) {
      if (errorEl) { errorEl.textContent = 'Could not connect to server'; errorEl.classList.remove('hidden'); }
    }
  });

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
      <p class="text-gray-300 text-sm leading-relaxed">"${text}"</p>
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
      // Silent fail — static reviews still show
    }
  }

  // Load user reviews after a short delay (let static ones render first)
  setTimeout(loadDynamicReviews, 2000);
})();
