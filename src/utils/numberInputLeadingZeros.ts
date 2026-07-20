// Global fix for number inputs showing a stale leading zero ("05" after
// typing 5 into a field holding 0). React compares number-input values
// loosely ("05" == 5), so it never rewrites the DOM even though the parsed
// state is correct - the zero stays on screen. Instead of patching every
// <input type="number"> individually, a document-level capture listener
// normalizes the raw value before React's own (root-level, bubble-phase)
// handler reads it, so both the display and e.target.value are clean.

// React instruments the `value` property to detect echoed writes; going
// through the native setter keeps our rewrite invisible to that tracker so
// the subsequent onChange still fires with the normalized value.
const nativeValueSetter = Object.getOwnPropertyDescriptor(
  HTMLInputElement.prototype,
  'value'
)!.set!;

// "05" → "5", "007" → "7", "-05" → "-5"; leaves "0", "0.5", "-0.25" alone
// (the lookahead requires a digit right after the stripped zeros).
const LEADING_ZEROS = /^(-?)0+(?=\d)/;

export function installNumberInputLeadingZeroFix(): void {
  document.addEventListener(
    'input',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLInputElement) || el.type !== 'number') return;
      const fixed = el.value.replace(LEADING_ZEROS, '$1');
      if (fixed !== el.value) {
        nativeValueSetter.call(el, fixed);
      }
    },
    true
  );
}
