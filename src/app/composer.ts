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

interface TurnstileApi {
  render: (el: HTMLElement, opts: {
    sitekey: string;
    callback: (token: string) => void;
    'error-callback'?: () => void;
  }) => string;
  reset: (id?: string) => void;
}

interface VoiceCertApi {
  captcha: (el: HTMLElement, opts: {
    siteKey: string;
    success: (token: string) => void;
    fail: (reason: string) => void;
  }) => { reset: () => void };
}

declare global {
  interface Window { turnstile?: TurnstileApi; VoiceCert?: VoiceCertApi }
}

/**
 * Third-party widgets are loaded on demand rather than in the page head: the
 * overwhelming majority of sessions never open the unattributed composer, and
 * neither script should cost anything until someone does.
 */
const loaders = new Map<string, Promise<unknown>>();

function loadScript<T>(src: string, pick: () => T | undefined): Promise<T | null> {
  const existing = loaders.get(src) as Promise<T | null> | undefined;
  if (existing) return existing;

  const ready = new Promise<T | null>((resolve) => {
    const found = pick();
    if (found) return resolve(found);
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve(pick() ?? null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
  loaders.set(src, ready);
  return ready;
}

const loadTurnstile = () => loadScript(
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
  () => window.turnstile,
);

const loadVoiceCert = () => loadScript(
  'https://www.voicecert.com/widget/v1.js',
  () => window.VoiceCert,
);

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
  /** Which proof the member is currently being offered. Voice is preferred. */
  private mode: 'voicecert' | 'captcha' = 'voicecert';

  constructor(root: HTMLElement, opts: ComposerOptions) {
    this.root = root;
    this.opts = opts;
    this.mode = this.voiceMethod() ? 'voicecert' : 'captcha';
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
    const voice = this.voiceMethod();
    const captcha = this.captchaMethod();
    const showingVoice = this.mode === 'voicecert' && Boolean(voice);

    // The alternative is only worth offering when there is one — with a single
    // configured provider this whole row disappears rather than dead-ending.
    const alternative = showingVoice
      ? (captcha ? html`<button class="btn btn--ghost btn--sm" data-action="verify-captcha">
            Can’t use voice right now — use a captcha
          </button>` : raw(''))
      : (voice ? html`<button class="btn btn--ghost btn--sm" data-action="verify-voice">
            Verify by voice instead
          </button>` : raw(''));

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
                ? html`<p class="verify__ok">
                    ${this.receipt?.strength === 'voice'
                      ? 'Voice-verified human · your name will not be attached.'
                      : 'Verified human · your name will not be attached.'}
                  </p>`
                : html`
                  <p class="composer__hint">
                    Readers will see “a verified human wrote this”, not who. Prove you are a
                    person to continue.
                  </p>
                  <div class="verify__widget" data-role="${showingVoice ? 'voicecert' : 'turnstile'}"></div>
                  ${alternative}
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

    if (this.anonymous && !this.receipt) void this.mountWidget();
  }

  private mountWidget() {
    return this.mode === 'voicecert' && this.voiceMethod()
      ? this.mountVoiceCert()
      : this.mountTurnstile();
  }

  /**
   * VoiceCert renders its own checkbox, QR code and polling loop; all we supply
   * is the site key and a place to put it. `success` fires with a token that
   * only the backend can redeem.
   */
  private async mountVoiceCert() {
    const holder = $('[data-role="voicecert"]', this.root);
    const method = this.voiceMethod();
    if (!holder || !method) return;

    const voicecert = await loadVoiceCert();
    if (!voicecert) {
      holder.textContent = this.captchaMethod()
        ? 'VoiceCert could not load. Use the captcha option, or post with your name.'
        : 'VoiceCert could not load. Try again, or post with your name.';
      return;
    }
    voicecert.captcha(holder, {
      siteKey: method.siteKey,
      success: (token: string) => void this.redeem('voicecert', token),
      fail: (reason: string) => {
        // The widget renders its own inline error and its own retry affordance,
        // so redrawing here would wipe both. Only surface the one case the
        // widget cannot explain — the app never being reachable at all.
        if (reason === 'network' && this.captchaMethod()) {
          this.setNotice('info', 'Could not reach VoiceCert. The captcha option still works.');
          this.redraw();
        }
      },
    });
  }

  private async mountTurnstile() {
    const holder = $('[data-role="turnstile"]', this.root);
    const method = this.captchaMethod();
    if (!holder || !method) return;

    const turnstile = await loadTurnstile();
    if (!turnstile) {
      holder.textContent = this.voiceMethod()
        ? 'Captcha could not load. Try verifying by voice, or post with your name.'
        : 'Captcha could not load. Try again, or post with your name.';
      return;
    }
    turnstile.render(holder, {
      sitekey: method.siteKey,
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
        this.mode = 'voicecert';
        this.notice = null;
        this.redraw();
      }
      if (target.closest('[data-action="verify-captcha"]')) {
        ev.preventDefault();
        this.mode = 'captcha';
        this.notice = null;
        this.redraw();
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
