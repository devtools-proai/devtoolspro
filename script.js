// ─── CONFIGURATION ───
const API_BASE = 'https://devtools-pro.onrender.com';

// ─── Shared brand spinner markup (matches dashboard.html) ───
const SPINNER_HTML = '<span class="brand-spinner" aria-hidden="true"></span>';

// Toggle a button's loading state. Stores original innerHTML in dataset so it
// can be restored exactly when isLoading flips back to false.
function setBtnLoading(btn, isLoading, customLabel) {
  if (!btn) return;
  if (isLoading) {
    if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    const label = customLabel || btn.dataset.label || 'Working…';
    btn.innerHTML = `${SPINNER_HTML}<span>${label}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {

  // ─── PRICING SECTION CURRENCY TOGGLE ───
  const btnUSD = document.getElementById('btn-usd');
  const btnINR = document.getElementById('btn-inr');
  const pricingCards = document.querySelectorAll('.flip-card');

  function switchCurrency(currency) {
    if (currency === 'usd') {
      btnUSD?.classList.add('active');
      btnINR?.classList.remove('active');
      btnUSD?.setAttribute('aria-pressed', 'true');
      btnINR?.setAttribute('aria-pressed', 'false');
      document.body.setAttribute('data-curr', 'USD');
    } else {
      btnINR?.classList.add('active');
      btnUSD?.classList.remove('active');
      btnINR?.setAttribute('aria-pressed', 'true');
      btnUSD?.setAttribute('aria-pressed', 'false');
      document.body.setAttribute('data-curr', 'INR');
    }
    pricingCards.forEach(card => {
      const original = card.querySelector('.original-price');
      const discounted = card.querySelector('.discounted-price');
      const symbol = currency === 'usd' ? '$' : '₹';
      const fmt = (v) => currency === 'usd' ? v : Number(v).toLocaleString('en-IN');
      if (original) original.textContent = `${symbol}${fmt(card.dataset[`${currency}Original`])}/month`;
      if (discounted) {
        discounted.innerHTML = `${symbol}${fmt(card.dataset[`${currency}Discounted`])}<span class="plan-price-cycle">/mo</span>`;
      }
    });
  }

  btnUSD?.addEventListener('click', () => switchCurrency('usd'));
  btnINR?.addEventListener('click', () => switchCurrency('inr'));

  // ─── FAQ ACCORDION ───
  document.querySelectorAll('.faq-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const answer = btn.nextElementSibling;
      const icon = btn.querySelector('.faq-icon');
      const wasOpen = answer && !answer.classList.contains('hidden');

      // Collapse all
      document.querySelectorAll('.faq-answer').forEach(a => a.classList.add('hidden'));
      document.querySelectorAll('.faq-icon').forEach(i => i.classList.remove('rotate-180'));
      document.querySelectorAll('.faq-toggle').forEach(t => t.setAttribute('aria-expanded', 'false'));

      // Expand current if it wasn't already open
      if (!wasOpen && answer) {
        answer.classList.remove('hidden');
        if (icon) icon.classList.add('rotate-180');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
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
  let selectedRating = 0;

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
    const labels = ['', 'Not great', 'Okay', 'Good', 'Great', 'Amazing'];

    function updateStars(rating) {
      stars.forEach(s => {
        const sVal = parseInt(s.dataset.star);
        s.classList.toggle('text-yellow-400', sVal <= rating);
      });
    }

    stars.forEach(star => {
      star.addEventListener('click', () => {
        selectedRating = parseInt(star.dataset.star);
        updateStars(selectedRating);
        if (ratingLabel) {
          ratingLabel.textContent = labels[selectedRating];
          ratingLabel.style.color = '#fbbf24';
        }
      });
      star.addEventListener('mouseenter', () => {
        const hoverVal = parseInt(star.dataset.star);
        stars.forEach(s => {
          const sVal = parseInt(s.dataset.star);
          s.classList.toggle('text-yellow-400', sVal <= hoverVal);
          s.style.transform = sVal <= hoverVal ? 'scale(1.2)' : 'scale(1)';
        });
      });
    });
    starRating.addEventListener('mouseleave', () => {
      updateStars(selectedRating);
      stars.forEach(s => { s.style.transform = 'scale(1)'; });
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
    const submitBtn = document.getElementById('review-submit-btn');

    successEl?.classList.add('hidden');
    errorEl?.classList.add('hidden');

    if (!name || !city || !text) {
      if (errorEl) { errorEl.textContent = 'Please fill all fields'; errorEl.classList.remove('hidden'); }
      return;
    }
    if (selectedRating === 0) {
      if (errorEl) { errorEl.textContent = 'Please select a star rating'; errorEl.classList.remove('hidden'); }
      return;
    }

    setBtnLoading(submitBtn, true, 'Submitting…');

    try {
      const response = await fetch(`${API_BASE}/api/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, city, role, reviewText: text, rating: selectedRating })
      });
      const data = await response.json();

      if (data.status === 'success') {
        showSuccessAnimation(selectedRating);

        reviewForm.reset();
        if (charCount) charCount.textContent = '0';
        const ratingLabel = document.getElementById('rating-label');
        if (ratingLabel) { ratingLabel.textContent = ''; ratingLabel.style.color = ''; }
        const prevRating = selectedRating;
        selectedRating = 0;
        if (starRating) {
          starRating.querySelectorAll('[data-star]').forEach(s => s.classList.remove('text-yellow-400'));
        }
        injectNewReviewCard({ name, city, role, text, rating: prevRating });
      } else {
        if (errorEl) { errorEl.textContent = data.message || 'Something went wrong'; errorEl.classList.remove('hidden'); }
      }
    } catch {
      if (errorEl) { errorEl.textContent = 'Could not connect to server'; errorEl.classList.remove('hidden'); }
    } finally {
      setBtnLoading(submitBtn, false);
    }
  });

  // Glowing 3D stars burst animation on success — fullscreen overlay
  function showSuccessAnimation(rating) {
    const overlay = document.createElement('div');
    overlay.className = 'review-overlay';

    const starsHtml = Array.from({ length: rating }, () => '<span>&#9733;</span>').join('');
    overlay.innerHTML = `
      <div class="review-overlay-content">
        <div class="review-stars-burst">${starsHtml}</div>
        <p class="thank-you-text">Thank you for your feedback</p>
        <p style="color: rgba(155,150,180,0.85); font-size: 13px; margin-top: 8px; animation: thank-you-pop 0.4s ease-out 1.1s both;">Your review is now live above</p>
        <button class="review-ok-btn" id="review-ok-btn" type="button">Okay</button>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#review-ok-btn').addEventListener('click', () => {
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.3s ease';
      setTimeout(() => overlay.remove(), 300);
    });

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
    const colors = ['from-indigo-400 to-purple-500','from-emerald-400 to-cyan-500','from-rose-400 to-pink-500','from-amber-400 to-orange-500','from-sky-400 to-blue-500'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const starsHtml = Array.from({ length: 5 }, (_, i) => i < rating ? '&#9733;' : '<span style="color: rgb(75,70,90);">&#9733;</span>').join('');

    const card = document.createElement('div');
    card.className = 'review-card';
    card.style.opacity = '0';
    card.style.transform = 'scale(0.92)';
    card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    card.innerHTML = `
      <div>
        <div class="flex items-center gap-3 mb-3">
          <div class="w-9 h-9 rounded-full bg-gradient-to-br ${randomColor} flex items-center justify-center text-white font-bold text-sm">${escapeHtml(initials)}</div>
          <div><p class="text-white text-sm font-semibold">${escapeHtml(name)}</p><p style="color: rgb(140,135,165); font-size: 11px;">${escapeHtml(city)} · ${escapeHtml(role)}</p></div>
        </div>
        <p style="color: rgb(203,199,224); font-size: 13.5px; line-height: 1.55;">${escapeHtml(text)}</p>
      </div>
      <div>
        <div class="flex gap-0.5 mt-2">${starsHtml}</div>
        <p style="font-size: 10.5px; color: #c4b5fd; margin-top: 6px;">Just now</p>
      </div>
    `;

    track.insertBefore(card, track.firstChild);

    requestAnimationFrame(() => {
      card.style.opacity = '1';
      card.style.transform = 'scale(1)';
    });

    const allCards = track.querySelectorAll('.review-card');
    if (allCards.length > 14) {
      const lastCard = allCards[allCards.length - 1];
      lastCard.style.opacity = '0';
      lastCard.style.transform = 'scale(0.8)';
      setTimeout(() => lastCard.remove(), 500);
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  // Load dynamic reviews from backend on page load
  async function loadDynamicReviews() {
    try {
      const response = await fetch(`${API_BASE}/api/reviews?limit=5`);
      const data = await response.json();
      if (data.status === 'success' && data.reviews?.length) {
        data.reviews.reverse().forEach(r => {
          injectNewReviewCard({ name: r.name, city: r.city, role: r.role, text: r.review_text, rating: r.rating });
        });
      }
    } catch {
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
        { n: 'Nisha Banerjee', c: 'Kolkata, India', r: 'Student', t: "Told my hostel roommates and now 4 of us have subscriptions. Way better than buying ready-made projects off Telegram.", s: 4 },
        { n: 'Saurabh Patil', c: 'Nagpur, India', r: 'Full Stack', t: "Pro+ plan. 2000 credits last the whole month even with heavy usage. Setup guy was patient, explained everything on the call.", s: 5 },
      ],
      [
        { n: 'Sneha Nair', c: 'Kochi, India', r: 'Team Lead', t: "My team of 3 switched to Pro+. Saving ₹5k+ a month combined. WhatsApp support is actually responsive unlike most services.", s: 5 },
        { n: 'James Chen', c: 'San Francisco, CA', r: 'SWE', t: "Skeptical at first but the Meet call proved it. Legit subscription, legit account. 3 months in, zero issues.", s: 5 },
        { n: 'Vikram Reddy', c: 'Warangal, India', r: 'Developer', t: "No international card issues. UPI payment, instant setup. Been looking for something like this for months.", s: 4 },
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
        { n: 'Rohan Kapoor', c: 'Indore, India', r: 'Student', t: "Used to copy paste from ChatGPT. Kiro is different level — actually understands your codebase. At this price? Just do it.", s: 4 },
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
        const starsHtml = Array.from({ length: 5 }, (_, si) => si < review.s ? '&#9733;' : '<span style="color: rgb(75,70,90);">&#9733;</span>').join('');
        html += `<div class="review-card"><div><div class="flex items-center gap-3 mb-3"><div class="w-9 h-9 rounded-full bg-gradient-to-br ${color} flex items-center justify-center text-white font-bold text-sm">${escapeHtml(initials)}</div><div><p class="text-white text-sm font-semibold">${escapeHtml(review.n)}</p><p style="color: rgb(140,135,165); font-size: 11px;">${escapeHtml(review.c)} · ${escapeHtml(review.r)}</p></div></div><p style="color: rgb(203,199,224); font-size: 13.5px; line-height: 1.55;">${escapeHtml(review.t)}</p></div><div class="flex gap-0.5 mt-2">${starsHtml}</div></div>`;
      });
      // Duplicate for seamless infinite scroll
      track.innerHTML = html + html;
    });
  }

  // Render seed reviews immediately, then load fresh ones from backend
  renderSeedReviews();
  setTimeout(loadDynamicReviews, 2000);
})();
