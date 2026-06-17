// ─── CONFIGURATION ───
const WHATSAPP_NUMBER = '919019879108';

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
    toStep2Btn.addEventListener('click', () => {
      const radio = document.querySelector('input[name="selectedPlan"]:checked');
      const planError = document.getElementById('plan-error');
      if (!radio) { if (planError) planError.classList.remove('hidden'); return; }
      if (planError) planError.classList.add('hidden');
      selectedPlan = radio.value;
      const amount = Number(radio.dataset.amount);

      const amountEl = document.getElementById('payment-amount');
      if (amountEl) amountEl.textContent = 'Amount: ₹' + amount.toLocaleString('en-IN');

      const upiString = `upi://pay?pa=9019879108@kotakbank&pn=DevTools%20Pro&am=${amount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      
      // Set app-specific deep links
      const phonePeLink = document.getElementById('phonepe-link');
      const gpayLink = document.getElementById('gpay-link');
      const upiLink = document.getElementById('upi-link');
      
      const phonepeUrl = `phonepe://pay?pa=9019879108@kotakbank&pn=DevTools%20Pro&am=${amount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      const gpayUrl = `tez://upi/pay?pa=9019879108@kotakbank&pn=DevTools%20Pro&am=${amount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' —')[0].trim())}`;
      
      if (phonePeLink) phonePeLink.href = phonepeUrl;
      if (gpayLink) gpayLink.href = gpayUrl;
      if (upiLink) upiLink.href = upiString;

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
  if (backTo1) backTo1.addEventListener('click', () => showStep(1));
  if (backTo2) backTo2.addEventListener('click', () => showStep(2));

  // ─── COPY UPI ───
  const copyBtn = document.getElementById('copy-upi');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText('9019879108@kotakbank');
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
      case 'utrId': if (!v) { showError(field, 'Required'); return false; } if (v.length < 6) { showError(field, 'Enter valid UTR'); return false; } break;
    }
    clearError(field); return true;
  }

  // ─── FORM SUBMIT → WHATSAPP ───
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const firstName = document.getElementById('firstName');
      const lastName = document.getElementById('lastName');
      const email = document.getElementById('emailId');
      const utr = document.getElementById('utrId');
      const fields = [firstName, lastName, email, utr];
      const isValid = fields.every(f => validateField(f));
      if (isValid) {
        const message = `Hi! I've made the payment and want to set up my subscription.\n\nFirst Name: ${firstName.value.trim()}\nLast Name: ${lastName.value.trim()}\nEmail: ${email.value.trim()}\nSelected Plan: ${selectedPlan}\nUTR/Transaction ID: ${utr.value.trim()}\n\nPlease verify and schedule my 1:1 Google Meet setup. Thanks!`;
        window.open(`https://api.whatsapp.com/send?phone=${WHATSAPP_NUMBER}&text=${encodeURIComponent(message)}`, '_blank');
        showStep(4);
      }
    });
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
