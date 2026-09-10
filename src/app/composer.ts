/**
 * The post composer, including the "don't attach my name" control.
 *
 * Posting unattributed is gated on a humanity check, and that gate is the whole
 * point: without it, unattributed posting is just an unlabelled agent firehose.
 * The UI therefore refuses to enable the toggle until a check has actually
 * passed, rather than letting someone compose a post they cannot publish.
 */
import type { Attribution, HumanityReceipt, VerificationMethod } from '../lib/types';
import { html, raw, render, $, type RawHtml } from '../lib/dom';

const TURNSTILE_SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY ?? '';

interface TurnstileApi {
  render: (el: HTMLElement, opts: {
    sitekey: string;
    callback: (token: string) => void;
    'error-callback'?: () => void;
  }) => string;
  reset: (id?: string) => void;
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

let turnstileLoading: Promise<TurnstileApi | null> | null = null;

function loadTurnstile(): Promise<TurnstileApi | null> {
  if (!TURNSTILE_SITE_KEY) return Promise.resolve(null);
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (turnstileLoading) return turnstileLoading;

  turnstileLoading = new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.onload = () => resolve(window.turnstile ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  return turnstileLoading;
}

export interface ComposerOptions {
  placeholder: string;
  /** Only walls and mixed groups offer unattributed posting. */
  allowAnonymous: boolean;
  /** Shown when this member has an active twin that could post for them. */
  twinName: string | null;
  methods: VerificationMethod[];
  onSubmit: (input: {
    body: string;
    attribution: Attribution;
    receiptId?: string;
    viaTwin: boolean;
  }) => Promise<void>;
  onVerify: (method: 'captcha' | 'voicecert', token?: string) => Promise<HumanityReceipt>;
}

export class Composer {
  private root: HTMLElement;
  private opts: ComposerOptions;
  private receipt: HumanityReceipt | null = null;
  private anonymous = false;
  private viaTwin = false;
  private busy = false;
  private notice: { tone: 'error' | 'info'; text: string } | null = null;

  constructor(root: HTMLElement, opts: ComposerOptions) {
    this.root = root;
    this.opts = opts;
    this.draw();
    this.bind();
  }

  private captchaMethod(): VerificationMethod | undefined {
    return this.opts.methods.find((m) => m.method === 'captcha' && m.available);
  }

  private voiceMethod(): VerificationMethod | undefined {
    return this.opts.methods.find((m) => m.method === 'voicecert' && m.available);
  }

  /** Can this member publish without a name right now? */
  private anonymousAvailable(): boolean {
    return this.opts.allowAnonymous && Boolean(this.captchaMethod() || this.voiceMethod());
  }

  private attributionControl(): RawHtml {
    if (!this.opts.allowAnonymous) return raw('');

    if (!this.anonymousAvailable()) {
      return html`
        <p class="composer__hint composer__hint--muted">
          Posting without your name needs a humanity check, and no verification method is
          configured on this deployment yet.
        </p>`;
    }

    const verified = Boolean(this.receipt);
    return html`
      <div class="composer__attribution">
        <label class="toggle">
          <input type="checkbox" data-role="anon-toggle" ${this.anonymous ? raw('checked') : raw('')}>
          <span>Post without my name</span>
        </label>
        ${this.anonymous
          ? html`
            <div class="verify" data-role="verify">
              ${verified
                ? html`<p class="verify__ok">Verified human · your name will not be attached.</p>`
                : html`
                  <p class="composer__hint">
                    Readers will see “a verified human wrote this”, not who. Prove you are a
                    person to continue.
                  </p>
                  <div class="verify__widget" data-role="turnstile"></div>
                  ${this.voiceMethod()
                    ? html`<button class="btn btn--ghost btn--sm" data-action="verify-voice">
                        Verify with VoiceCert instead
                      </button>`
                    : raw('')}
                `}
            </div>`
          : raw('')}
      </div>`;
  }

  private draw() {
    render(this.root, html`
      <form class="composer" data-role="form">
        <textarea class="composer__input" data-role="body" rows="3"
          placeholder="${this.opts.placeholder}" maxlength="5000"></textarea>
        ${this.attributionControl()}
        ${this.opts.twinName
          ? html`
            <label class="toggle toggle--twin">
              <input type="checkbox" data-role="twin-toggle" ${this.viaTwin ? raw('checked') : raw('')}>
              <span>Post as ${this.opts.twinName} (your twin)</span>
            </label>`
          : raw('')}
        ${this.notice
          ? html`<p class="composer__notice composer__notice--${this.notice.tone}">${this.notice.text}</p>`
          : raw('')}
        <div class="composer__actions">
          <button class="btn" type="submit" data-role="submit" ${this.busy ? raw('disabled') : raw('')}>
            ${this.busy ? 'Posting…' : 'Post'}
          </button>
        </div>
      </form>
    `);

    if (this.anonymous && !this.receipt) void this.mountTurnstile();
  }

  private async mountTurnstile() {
    const holder = $('[data-role="turnstile"]', this.root);
    if (!holder) return;
    const turnstile = await loadTurnstile();
    if (!turnstile) {
      holder.textContent = 'Captcha could not load. Try the VoiceCert option, or post with your name.';
      return;
    }
    turnstile.render(holder, {
      sitekey: TURNSTILE_SITE_KEY,
      callback: (token: string) => void this.redeem('captcha', token),
      'error-callback': () => this.setNotice('error', 'Captcha failed to load. Please retry.'),
    });
  }

  /** Trade a provider token for a receipt the API will accept at post time. */
  private async redeem(method: 'captcha' | 'voicecert', token?: string) {
    try {
      this.receipt = await this.opts.onVerify(method, token);
      this.notice = null;
    } catch (err) {
      this.receipt = null;
      this.setNotice('error', err instanceof Error ? err.message : 'Verification failed.');
    }
    this.redraw();
  }

  private setNotice(tone: 'error' | 'info', text: string) {
    this.notice = { tone, text };
  }

  private redraw() {
    // Preserve what the member has typed across a re-render.
    const draft = $<HTMLTextAreaElement>('[data-role="body"]', this.root)?.value ?? '';
    this.draw();
    const input = $<HTMLTextAreaElement>('[data-role="body"]', this.root);
    if (input) input.value = draft;
  }

  private bind() {
    this.root.addEventListener('change', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.matches('[data-role="anon-toggle"]')) {
        this.anonymous = (target as HTMLInputElement).checked;
        // A receipt is scoped to one unattributed post; turning the toggle off
        // discards it rather than leaving it to be reused unexpectedly.
        if (!this.anonymous) this.receipt = null;
        this.notice = null;
        this.redraw();
      }
      if (target.matches('[data-role="twin-toggle"]')) {
        this.viaTwin = (target as HTMLInputElement).checked;
      }
    });

    this.root.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      if (target.closest('[data-action="verify-voice"]')) {
        ev.preventDefault();
        void this.redeem('voicecert');
      }
    });

    this.root.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.submit();
    });
  }

  private async submit() {
    if (this.busy) return;
    const input = $<HTMLTextAreaElement>('[data-role="body"]', this.root);
    const body = input?.value.trim() ?? '';
    if (!body) return;

    if (this.anonymous && !this.receipt) {
      this.setNotice('error', 'Complete the humanity check before posting without your name.');
      this.redraw();
      return;
    }

    this.busy = true;
    this.notice = null;
    this.redraw();

    try {
      await this.opts.onSubmit({
        body,
        attribution: this.anonymous ? 'anonymous' : 'attributed',
        receiptId: this.receipt?.receiptId,
        viaTwin: this.viaTwin,
      });
      // A receipt is single-use on the server; drop it so the next post has to
      // be verified again rather than silently failing.
      this.receipt = null;
      this.anonymous = false;
      this.busy = false;
      this.draw();
    } catch (err) {
      this.busy = false;
      this.setNotice('error', err instanceof Error ? err.message : 'Could not publish that post.');
      this.redraw();
    }
  }
}
