/**
 * The submit form's pending state.
 *
 * Verification is a synchronous POST that fetches the page, fetches the feed, and —
 * since the rendering fallback landed — may spend a few more seconds asking a
 * rendering service for the finished page. Four seconds is normal for a JS-rendered
 * site. With no feedback the form looks broken, and the natural response is to click
 * again, which spends a second full verification and can trip the rate limiter on the
 * user's own second attempt.
 *
 * This is progressive enhancement, and the form is the thing that works. Without
 * JavaScript, or before this file loads, submitting still does exactly what it did:
 * the disabling happens in a `submit` listener, so the browser has already built the
 * form data set and resolved which button's `formaction` it is posting to by the time
 * anything here runs. Nothing is intercepted and nothing is prevented.
 */

const PENDING_LABEL = 'Validating website…';

/**
 * Both buttons are disabled, not just the clicked one. They post to different
 * actions — "Submit my site" to `/submit`, "Just test it" to `/check` — so leaving
 * the other one live means the second click starts a *different* verification over
 * the top of the first.
 */
function markPending(form, submitter) {
  if (form.dataset.pending === 'true') return;
  form.dataset.pending = 'true';
  form.setAttribute('aria-busy', 'true');

  for (const button of form.querySelectorAll('button[type="submit"]')) {
    // Pinned before the label is swapped. "Validating website…" is wider than "Just
    // test it, don't list me" is narrow, and on the ≥40rem layout — where the actions
    // are a flex row — an unpinned button resizes and shoves its neighbour sideways
    // at the exact moment the user is looking at it.
    button.style.minWidth = `${button.offsetWidth}px`;
    button.dataset.label = button.textContent;
    button.disabled = true;

    if (button === submitter) {
      const spinner = document.createElement('span');
      spinner.className = 'submit-form__spinner';
      // The label beside it already says what is happening; announcing a decorative
      // ring as well would just be noise.
      spinner.setAttribute('aria-hidden', 'true');

      button.replaceChildren(spinner, document.createTextNode(PENDING_LABEL));
    }
  }

  // A disabled button's label change is not reliably announced — and the click may
  // well have moved focus off it. `role="status"` is the part a screen reader is
  // guaranteed to hear.
  const status = form.querySelector('.submit-form__status');
  if (status !== null) status.textContent = PENDING_LABEL;
}

function clearPending(form) {
  if (form.dataset.pending !== 'true') return;
  delete form.dataset.pending;
  form.removeAttribute('aria-busy');

  for (const button of form.querySelectorAll('button[type="submit"]')) {
    if (button.dataset.label !== undefined) {
      button.textContent = button.dataset.label;
      delete button.dataset.label;
    }
    button.style.minWidth = '';
    button.disabled = false;
  }

  const status = form.querySelector('.submit-form__status');
  if (status !== null) status.textContent = '';
}

for (const form of document.querySelectorAll('.submit-form')) {
  form.addEventListener('submit', (event) => {
    // `submitter` is null for a form submitted by pressing Enter in the field, which
    // is how a good share of people will send this one. That still needs both buttons
    // disabled; it just has no button to put the spinner in, so the `role="status"`
    // line carries it alone.
    markPending(form, event.submitter);
  });
}

/**
 * Back-button restores.
 *
 * `POST /submit` re-renders the page rather than redirecting, so "submit, read the
 * result, go back" lands on a page served from the bfcache with the DOM exactly as it
 * was left — every button disabled, spinner still there, and no way to try again
 * short of a reload. The pending state is a property of an in-flight request, and a
 * restored page has none.
 */
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  for (const form of document.querySelectorAll('.submit-form')) clearPending(form);
});
