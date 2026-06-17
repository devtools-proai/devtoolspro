// ─── CONFIGURATION ───
const WHATSAPP_NUMBER = '919019879108';

document.addEventListener('DOMContentLoaded', () => {
  // ─── DOM REFERENCES ───
  const step1 = document.getElementById('step-1');
  const step2 = document.getElementById('step-2');
  const step3 = document.getElementById('step-3');
  const stepSuccess = document.getElementById('step-success');
  const form = document.getElementById('signup-form');
  const header = document.querySelector('header');

  // Step indicators
  const stepInds = [document.getElementById('step-ind-1'), document.getElementById('step-ind-2'), document.getElementById('step-ind-3')];
  const stepLines = [document.getElementById('step-line-1'), document.getElementById('step-line-2')];

  let selectedPlan = '';

  // ─── STEP NAVIGATION HELPERS ───
  function showStep(num) {
    [step1, step2, step3, stepSuccess].forEach(el => el.classList.add('hidden'));
    if (num === 1) step1.classList.remove('hidden');
    if (num === 2) step2.classList.remove('hidden');
    if (num === 3) step3.classList.remove('hidden');
    if (num === 4) stepSuccess.classList.remove('hidden');

    // Update indicators
    stepInds.forEach((ind, i) => {
      if (i < num) {
        ind.classList.remove('bg-gray-700', 'text-gray-400');
        ind.classList.add('bg-indigo-600', 'text-white');
      } else {
        ind.classList.remove('bg-indigo-600', 'text-white');
        ind.classList.add('bg-gray-700', 'text-gray-400');
      }
    });
    stepLines.forEach((line, i) => {
      line.classList.toggle('bg-indigo-600', i < num - 1);
      line.classList.toggle('bg-gray-700', i >= num - 1);
    });
  }

  // ─── STEP 1 → STEP 2 ───
  const PLAN_AMOUNTS_RAW = {
    'Pro — ₹946/month (1,000 credits)': 946,
    'Pro+ — ₹1,892/month (2,000 credits)': 1892,
    'Pro Max — ₹4,731/month (5,000 credits)': 4731,
    'Power — ₹9,461/month (10,000 credits)': 9461,
  };

  document.getElementById('to-step-2').addEventListener('click', () => {
    const radio = document.querySelector('input[name="selectedPlan"]:checked');
    const planError = document.getElementById('plan-error');
    if (!radio) {
      planError.classList.remove('hidden');
      return;
    }
    planError.classList.add('hidden');
    selectedPlan = radio.value;
    const amount = PLAN_AMOUNTS_RAW[selectedPlan];
    document.getElementById('payment-amount').textContent = 'Amount: ₹' + amount.toLocaleString('en-IN');
    
    // Set UPI deep link with amount pre-filled
    const upiLink = `upi://pay?pa=9019879108@kotakbank&pn=DevTools%20Pro&am=${amount}&cu=INR&tn=${encodeURIComponent('DevTools Pro - ' + selectedPlan.split(' — ')[0])}`;
    document.getElementById('upi-pay-link').href = upiLink;
    
    showStep(2);
  });

  // ─── STEP 2 → STEP 3 ───
  document.getElementById('to-step-3').addEventListener('click', () => {
    showStep(3);
    document.getElementById('selected-plan-display').textContent = selectedPlan;
  });

  // ─── BACK BUTTONS ───
  document.getElementById('back-to-1').addEventListener('click', () => showStep(1));
  document.getElementById('back-to-2').addEventListener('click', () => showStep(2));

  // ─── COPY UPI ID ───
  document.getElementById('copy-upi').addEventListener('click', () => {
    navigator.clipboard.writeText('9019879108@kotakbank');
    const btn = document.getElementById('copy-upi');
    btn.innerHTML = '<svg class="w-4 h-4 text-emerald-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>';
    setTimeout(() => {
      btn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/></svg>';
    }, 2000);
  });

  // ─── VALIDATION ───
  function validateEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  }

  function showError(field, message) {
    const errorEl = document.getElementById(`${field.id}-error`);
    if (errorEl) { errorEl.textContent = message; errorEl.classList.remove('hidden'); }
    field.classList.add('border-red-500');
    field.classList.remove('border-gray-700');
  }

  function clearError(field) {
    const errorEl = document.getElementById(`${field.id}-error`);
    if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
    field.classList.remove('border-red-500');
    field.classList.add('border-gray-700');
  }

  function validateField(field) {
    const value = field.value.trim();
    switch (field.id) {
      case 'firstName':
        if (!value) { showError(field, 'Required'); return false; } break;
      case 'lastName':
        if (!value) { showError(field, 'Required'); return false; } break;
      case 'emailId':
        if (!value) { showError(field, 'Required'); return false; }
        if (!validateEmail(value)) { showError(field, 'Invalid email'); return false; } break;
      case 'utrId':
        if (!value) { showError(field, 'Required'); return false; }
        if (value.length < 6) { showError(field, 'Enter valid UTR'); return false; } break;
    }
    clearError(field);
    return true;
  }

  // ─── FORM SUBMIT → WHATSAPP ───
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

      const whatsappUrl = `https://api.whatsapp.com/send?phone=${WHATSAPP_NUMBER}&text=${encodeURIComponent(message)}`;
      window.open(whatsappUrl, '_blank');

      // Show success
      showStep(4);
    }
  });

  // Real-time validation on blur
  ['firstName', 'lastName', 'emailId', 'utrId'].forEach(id => {
    const field = document.getElementById(id);
    if (field) {
      field.addEventListener('blur', () => validateField(field));
      field.addEventListener('input', () => {
        if (field.classList.contains('border-red-500')) validateField(field);
      });
    }
  });

  // ─── PRICING SECTION CURRENCY TOGGLE (unchanged) ───
  const btnUSD = document.getElementById('btn-usd');
  const btnINR = document.getElementById('btn-inr');
  const pricingCards = document.querySelectorAll('.flip-card');
  let currentCurrency = 'usd';

  function switchCurrency(currency) {
    currentCurrency = currency;
    if (currency === 'usd') {
      btnUSD.classList.add('bg-indigo-600', 'text-white'); btnUSD.classList.remove('text-gray-400');
      btnINR.classList.remove('bg-indigo-600', 'text-white'); btnINR.classList.add('text-gray-400');
    } else {
      btnINR.classList.add('bg-indigo-600', 'text-white'); btnINR.classList.remove('text-gray-400');
      btnUSD.classList.remove('bg-indigo-600', 'text-white'); btnUSD.classList.add('text-gray-400');
    }
    pricingCards.forEach(card => {
      const inner = card.querySelector('.flip-card-inner');
      inner.classList.add('flipping');
      setTimeout(() => {
        const original = card.querySelector('.original-price');
        const discounted = card.querySelector('.discounted-price');
        const symbol = currency === 'usd' ? '$' : '₹';
        original.textContent = `${symbol}${card.dataset[`${currency}Original`]}/month`;
        discounted.innerHTML = `${symbol}${card.dataset[`${currency}Discounted`]}<span class="text-base font-normal text-gray-400">/mo</span>`;
      }, 300);
      setTimeout(() => inner.classList.remove('flipping'), 600);
    });
  }

  btnUSD.addEventListener('click', () => switchCurrency('usd'));
  btnINR.addEventListener('click', () => switchCurrency('inr'));

  // ─── HEADER SCROLL ───
  window.addEventListener('scroll', () => {
    header.style.background = window.scrollY > 50 ? 'rgba(3,7,18,0.95)' : 'rgba(17,24,39,0.8)';
  });

  // ─── FAQ ACCORDION ───
  document.querySelectorAll('.faq-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const answer = btn.nextElementSibling;
      const icon = btn.querySelector('.faq-icon');
      const isOpen = !answer.classList.contains('hidden');
      document.querySelectorAll('.faq-answer').forEach(a => a.classList.add('hidden'));
      document.querySelectorAll('.faq-icon').forEach(i => i.classList.remove('rotate-180'));
      if (!isOpen) { answer.classList.remove('hidden'); icon.classList.add('rotate-180'); }
    });
  });

  // ─── SCROLL REVEAL ───
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.style.opacity = '1'; entry.target.style.transform = 'translateY(0)'; }
    });
  }, { threshold: 0.1 });

  document.querySelectorAll('#pricing .flip-card, #what .bg-gray-900\\/50').forEach(el => {
    el.style.opacity = '0'; el.style.transform = 'translateY(20px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    observer.observe(el);
  });
});
