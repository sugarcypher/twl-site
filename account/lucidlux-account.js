/*
 * Lucid Lux account — one sign-in for every game on lucidlux.fyi.
 *
 * No libraries. Talks to Supabase Auth (email one-time code) and to the
 * public.ll_* database functions directly over fetch. Every game on the site
 * shares the same session, so signing in once signs you in everywhere.
 *
 *   const acct = LucidLuxAccount.create({ game: 'tapboom' });
 *   acct.on(fn)                 // fn(state) on every change
 *   acct.open()                 // the sign-in / account panel
 *   await acct.submitRun({...}) // record a round; returns {ok, new_badges}
 *   await acct.dailyBoard(id)   // anyone, signed in or not
 *
 * Order of the sign-in panel, deliberately: age first, then email. Nobody
 * under 13 is asked for an email address at all.
 */
(function (global) {
  'use strict';

  var CONFIG = {
    url: 'https://tsbazrbdkojzhnglakcv.supabase.co',
    key: 'sb_publishable_vh7FTPtBkkg-RKyePDgfeA_nqIc-8py',
  };
  var SESSION_KEY = 'lucidlux.session.v1';
  var UNDER13_KEY = 'lucidlux.under13.v1';
  var EMAIL_KEY = 'lucidlux.lastEmail.v1';

  function read(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function write(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function now() { return Math.floor(Date.now() / 1000); }

  // ------------------------------------------------------------- transport

  function request(path, opts, token) {
    var headers = { 'apikey': CONFIG.key, 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 12000) : null;
    return fetch(CONFIG.url + path, {
      method: opts.method || 'POST',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl ? ctrl.signal : undefined,
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (t) {
        var data = null;
        try { data = t ? JSON.parse(t) : null; } catch (e) { data = t; }
        return { ok: res.ok, status: res.status, data: data };
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      return { ok: false, status: 0, data: { message: 'offline' }, offline: true };
    });
  }

  function errorText(r) {
    if (r.offline) return 'No connection. Your game is still saved on this device.';
    var d = r.data || {};
    var code = d.error_code || d.code || '';
    var msg = d.msg || d.message || d.error_description || d.error || '';
    if (code === 'otp_expired' || /expired|invalid/i.test(msg)) return 'That code did not work. Check the newest email, or send a new code.';
    if (code === 'over_email_send_rate_limit' || r.status === 429) return 'Too many codes asked for. Wait a minute and try again.';
    if (/not authorized/i.test(msg)) return 'Sign-in email is not switched on yet for this site.';
    if (/email/i.test(msg) && /valid|format/i.test(msg)) return 'That email address does not look right.';
    return msg ? String(msg) : 'Something went wrong. Try again in a moment.';
  }

  // ------------------------------------------------------------- the account

  function Account(game) {
    this.game = game;
    this.session = read(SESSION_KEY);
    this.me = null;              // { player, badges }
    this.listeners = [];
    this.refreshing = null;
    this.panel = null;
  }

  Account.prototype.on = function (fn) { this.listeners.push(fn); return this; };
  Account.prototype.emit = function () {
    var s = this.state();
    for (var i = 0; i < this.listeners.length; i++) { try { this.listeners[i](s); } catch (e) {} }
  };
  Account.prototype.state = function () {
    return {
      signedIn: !!this.session,
      email: this.session && this.session.user ? this.session.user.email : null,
      player: this.me ? this.me.player : null,
      badges: this.me ? (this.me.badges || []) : [],
      under13: !!read(UNDER13_KEY),
    };
  };
  Object.defineProperty(Account.prototype, 'signedIn', { get: function () { return !!this.session; } });
  Object.defineProperty(Account.prototype, 'player', { get: function () { return this.me ? this.me.player : null; } });
  Object.defineProperty(Account.prototype, 'under13', { get: function () { return !!read(UNDER13_KEY); } });

  Account.prototype.setSession = function (s) {
    if (s && s.access_token) {
      this.session = {
        access_token: s.access_token,
        refresh_token: s.refresh_token,
        expires_at: s.expires_at || (now() + (s.expires_in || 3600)),
        user: s.user ? { id: s.user.id, email: s.user.email } : (this.session ? this.session.user : null),
      };
    } else {
      this.session = null;
      this.me = null;
    }
    write(SESSION_KEY, this.session);
  };

  /** A valid access token, refreshed when it is within a minute of expiry. */
  Account.prototype.token = function () {
    var self = this;
    var s = this.session;
    if (!s) return Promise.resolve(null);
    if (s.expires_at - now() > 60) return Promise.resolve(s.access_token);
    if (this.refreshing) return this.refreshing;
    this.refreshing = request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: s.refresh_token } })
      .then(function (r) {
        self.refreshing = null;
        if (r.ok && r.data && r.data.access_token) { self.setSession(r.data); return self.session.access_token; }
        if (r.offline) return s.access_token;          // try anyway; it may still be valid
        self.setSession(null); self.emit();             // refresh refused: signed out
        return null;
      });
    return this.refreshing;
  };

  /** Call a public.ll_* function. Signed in if possible, anonymous otherwise. */
  Account.prototype.rpc = function (name, args) {
    var self = this;
    return this.token().then(function (tok) {
      return request('/rest/v1/rpc/' + name, { body: args || {} }, tok).then(function (r) {
        if (r.status === 401 && tok) { self.setSession(null); self.emit(); }
        return r;
      });
    });
  };

  Account.prototype.sendCode = function (email) {
    write(EMAIL_KEY, email);
    return request('/auth/v1/otp', { body: { email: email, create_user: true, data: {} } })
      .then(function (r) { return r.ok ? { ok: true } : { ok: false, error: errorText(r) }; });
  };

  Account.prototype.verifyCode = function (email, code) {
    var self = this;
    return request('/auth/v1/verify', { body: { type: 'email', email: email, token: String(code).replace(/\D/g, '') } })
      .then(function (r) {
        if (!r.ok || !r.data || !r.data.access_token) return { ok: false, error: errorText(r) };
        self.setSession(r.data);
        return self.refresh().then(function () { return { ok: true }; });
      });
  };

  /** Reload the player record and earned badges. */
  Account.prototype.refresh = function () {
    var self = this;
    if (!this.session) { this.me = null; this.emit(); return Promise.resolve(null); }
    return this.rpc('ll_me').then(function (r) {
      if (r.ok && r.data) self.me = { player: r.data.player || null, badges: r.data.badges || [] };
      self.emit();
      return self.me;
    });
  };

  Account.prototype.signOut = function () {
    var self = this;
    var tok = this.session ? this.session.access_token : null;
    this.setSession(null);
    this.emit();
    if (!tok) return Promise.resolve();
    return request('/auth/v1/logout?scope=local', {}, tok).then(function () {}, function () {});
  };

  Account.prototype.nameOptions = function () {
    return this.rpc('ll_name_options', { p_count: 6 }).then(function (r) {
      return r.ok && Array.isArray(r.data) ? r.data.map(function (x) { return typeof x === 'string' ? x : x.ll_name_options; }) : [];
    });
  };

  Account.prototype.createPlayer = function (name, ageBand, shape, color) {
    var self = this;
    return this.rpc('ll_create_player', { p_name: name, p_age_band: ageBand, p_avatar_shape: shape | 0, p_avatar_color: color | 0 })
      .then(function (r) {
        if (r.ok && r.data && r.data.ok) { self.me = { player: r.data.player, badges: r.data.badges || [] }; self.emit(); return { ok: true }; }
        return { ok: false, error: errorText(r) };
      });
  };

  Account.prototype.updatePlayer = function (patch) {
    var self = this;
    return this.rpc('ll_update_player', {
      p_name: patch.name === undefined ? null : patch.name,
      p_avatar_shape: patch.shape === undefined ? null : patch.shape,
      p_avatar_color: patch.color === undefined ? null : patch.color,
      p_research_opt_in: patch.research === undefined ? null : patch.research,
    }).then(function (r) {
      if (r.ok && r.data && r.data.ok) { self.me = { player: r.data.player, badges: r.data.badges || [] }; self.emit(); return { ok: true }; }
      return { ok: false };
    });
  };

  Account.prototype.saveGet = function () {
    if (!this.session) return Promise.resolve(null);
    return this.rpc('ll_save_get', { p_game: this.game }).then(function (r) { return r.ok ? r.data : null; });
  };
  Account.prototype.savePut = function (state, baseRev) {
    if (!this.session || !this.player) return Promise.resolve({ ok: false, reason: 'signed_out' });
    return this.rpc('ll_save_put', { p_game: this.game, p_state: state, p_base_rev: baseRev })
      .then(function (r) { return r.ok && r.data ? r.data : { ok: false, reason: r.offline ? 'offline' : 'error' }; });
  };

  Account.prototype.submitRun = function (run) {
    var self = this;
    if (!this.session || !this.player) return Promise.resolve({ ok: false, reason: 'signed_out' });
    return this.rpc('ll_submit_run', {
      p_game: this.game, p_kind: run.kind, p_round_id: run.roundId || null,
      p_score: Math.round(run.score || 0), p_accuracy: Math.round(run.accuracy || 0),
      p_combo: run.combo | 0, p_level: run.level | 0, p_correct: run.correct | 0, p_wrong: run.wrong | 0,
      p_duration_ms: Math.round(run.durationMs || 0), p_finished: !!run.finished, p_version: run.version || null,
    }).then(function (r) {
      var d = r.ok && r.data ? r.data : { ok: false, reason: r.offline ? 'offline' : 'error' };
      if (d.ok && d.new_badges && d.new_badges.length && self.me) {
        for (var i = 0; i < d.new_badges.length; i++) {
          if (self.me.badges.indexOf(d.new_badges[i].slug) < 0) self.me.badges.push(d.new_badges[i].slug);
        }
        self.emit();
      }
      return d;
    });
  };

  Account.prototype.dailyBoard = function (roundId, limit) {
    return this.rpc('ll_daily_board', { p_game: this.game, p_round_id: roundId, p_limit: limit || 25 })
      .then(function (r) { return r.ok && Array.isArray(r.data) ? r.data : null; });
  };
  Account.prototype.hallOfFame = function (limit) {
    return this.rpc('ll_hall_of_fame', { p_game: this.game, p_limit: limit || 25 })
      .then(function (r) { return r.ok && Array.isArray(r.data) ? r.data : null; });
  };
  Account.prototype.badges = function () {
    return this.rpc('ll_badges', { p_game: this.game })
      .then(function (r) { return r.ok && Array.isArray(r.data) ? r.data : null; });
  };

  Account.prototype.deleteAccount = function () {
    var self = this;
    return this.rpc('ll_delete_me').then(function (r) {
      if (r.ok && r.data && r.data.ok) { self.setSession(null); self.emit(); return { ok: true }; }
      return { ok: false, error: errorText(r) };
    });
  };

  // ------------------------------------------------------------- save sync
  //
  // The game hands over three functions: collect() returns its saved state as
  // one object, apply(state) installs one (and may reload the page), and
  // progress(state) turns a state into one number so two copies can be
  // compared. On sign-in the copy with more progress wins; after that, each
  // push names the revision it started from, and a clash is settled the same way.

  Account.prototype.useSave = function (hooks) {
    this.saveHooks = hooks;
    this.revKey = 'lucidlux.rev.' + this.game;
    return this;
  };

  Account.prototype.reconcile = function () {
    var self = this, h = this.saveHooks;
    if (!h || !this.session || !this.player) return Promise.resolve('skipped');
    return this.saveGet().then(function (remote) {
      if (!remote) return 'offline';
      var local = h.collect();
      if (!remote.state) {
        return self.savePut(local, 0).then(function (r) { if (r.ok) write(self.revKey, r.rev); return 'uploaded'; });
      }
      var known = read(self.revKey);
      if (known === remote.rev) return 'current';           // this device wrote the latest copy
      if (h.progress(remote.state) > h.progress(local)) {
        write(self.revKey, remote.rev);
        h.apply(remote.state);
        return 'downloaded';
      }
      return self.savePut(local, remote.rev).then(function (r) { if (r.ok) write(self.revKey, r.rev); return 'uploaded'; });
    });
  };

  Account.prototype.push = function () {
    var self = this, h = this.saveHooks;
    if (!h || !this.session || !this.player) return Promise.resolve(false);
    if (this.pushTimer) clearTimeout(this.pushTimer);
    return new Promise(function (resolve) {
      self.pushTimer = setTimeout(function () {
        var base = read(self.revKey) || 0;
        self.savePut(h.collect(), base).then(function (r) {
          if (r.ok) { write(self.revKey, r.rev); resolve(true); return; }
          if (r.reason === 'conflict') { self.reconcile().then(function () { resolve(true); }); return; }
          resolve(false);
        });
      }, 400);
    });
  };

  // ------------------------------------------------------------- the panel

  var CSS = [
    '.llx-veil{position:fixed;inset:0;z-index:9999;background:rgba(10,10,14,.55);display:flex;align-items:center;justify-content:center;padding:16px;',
    'font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-text-size-adjust:100%}',
    '.llx-card{width:100%;max-width:420px;max-height:calc(100dvh - 32px);overflow:auto;background:#FFFFFF;color:#17171B;border-radius:20px;',
    'padding:22px 20px 18px;box-shadow:0 18px 50px rgba(0,0,0,.35);font-size:18px;line-height:1.45}',
    '@media (prefers-color-scheme:dark){.llx-card{background:#18181D;color:#F2F2F5}.llx-in{background:#0E0E12!important;color:#F2F2F5!important;border-color:#3A3A44!important}',
    '.llx-ghost{color:#C9C9D3!important}.llx-soft{color:#A9A9B5!important}.llx-opt{background:#22222A!important;color:#F2F2F5!important;border-color:#3A3A44!important}}',
    '.llx-card h2{margin:0 0 6px;font-size:24px;line-height:1.2}',
    '.llx-soft{color:#5B5B66;font-size:16px;margin:0 0 14px}',
    '.llx-in{width:100%;box-sizing:border-box;font:inherit;font-size:20px;padding:14px 14px;border-radius:12px;border:2px solid #CFCFD8;background:#FBFBFD;color:#17171B;margin:4px 0 12px}',
    '.llx-code{letter-spacing:.35em;text-align:center;font-size:28px;font-variant-numeric:tabular-nums}',
    '.llx-btn{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:19px;font-weight:650;padding:15px 16px;border-radius:14px;border:0;',
    'background:#E24B4B;color:#fff;margin:8px 0 0;cursor:pointer;min-height:54px}',
    '.llx-btn[disabled]{opacity:.5;cursor:default}',
    '.llx-ghost{background:transparent;color:#3A3A44;border:2px solid rgba(127,127,140,.35)}',
    '.llx-danger{background:transparent;color:#C0392B;border:2px solid rgba(192,57,43,.45)}',
    '.llx-opts{display:grid;grid-template-columns:1fr;gap:8px;margin:6px 0 4px}',
    '.llx-opt{font:inherit;font-size:19px;padding:14px;border-radius:12px;border:2px solid #CFCFD8;background:#F4F4F8;color:#17171B;cursor:pointer;text-align:left;min-height:54px}',
    '.llx-opt[aria-pressed="true"]{border-color:#E24B4B;box-shadow:0 0 0 2px #E24B4B inset}',
    '.llx-err{color:#C0392B;font-size:16px;min-height:1.2em;margin:4px 0 0}',
    '.llx-row{display:flex;gap:10px;align-items:center;justify-content:space-between;margin:10px 0}',
    '.llx-name{font-size:22px;font-weight:700}',
    '.llx-small{font-size:15px}',
    '.llx-x{float:right;font:inherit;font-size:16px;background:none;border:0;color:inherit;opacity:.7;padding:4px 6px;cursor:pointer}',
  ].join('');

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') for (var ev in attrs.on) e.addEventListener(ev, attrs.on[ev]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  Account.prototype.open = function (opts) {
    var self = this;
    opts = opts || {};
    if (!document.getElementById('llx-css')) {
      document.head.appendChild(h('style', { id: 'llx-css', text: CSS }));
    }
    this.close();
    var veil = h('div', { 'class': 'llx-veil', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lucid Lux account' });
    var card = h('div', { 'class': 'llx-card' });
    veil.appendChild(card);
    veil.addEventListener('click', function (e) { if (e.target === veil) self.close(); });
    document.body.appendChild(veil);
    this.panel = { veil: veil, card: card, flow: { avatar: opts.avatar || [0, 0] } };
    // Stop game input underneath while the panel is up.
    ['pointerdown', 'touchstart', 'keydown'].forEach(function (t) { veil.addEventListener(t, function (e) { e.stopPropagation(); }); });

    if (this.session) {
      this.refresh().then(function () { self.render(self.player ? 'account' : 'name'); });
      this.render('wait');
    } else if (this.under13) {
      this.render('under13');
    } else {
      this.render('age');
    }
  };

  Account.prototype.close = function () {
    if (this.panel && this.panel.veil.parentNode) this.panel.veil.parentNode.removeChild(this.panel.veil);
    this.panel = null;
  };

  Account.prototype.render = function (step) {
    var self = this, p = this.panel;
    if (!p) return;
    var c = p.card, f = p.flow;
    c.innerHTML = '';
    var close = h('button', { 'class': 'llx-x', type: 'button', 'aria-label': 'Close', text: 'Close', on: { click: function () { self.close(); } } });
    var err = h('p', { 'class': 'llx-err', role: 'alert' });
    function fail(t) { err.textContent = t || ''; }

    if (step === 'wait') {
      c.appendChild(close);
      c.appendChild(h('h2', { text: 'One moment…' }));
      return;
    }

    if (step === 'age') {
      // A neutral age question: no hint about which answer unlocks what.
      c.appendChild(close);
      c.appendChild(h('h2', { text: 'Save your progress' }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'Keep your level and badges, play on any device, and join the boards. First: how old are you?' }));
      var opts = h('div', { 'class': 'llx-opts' });
      [['Under 13', 'u13'], ['13 to 17', '13-17'], ['18 or older', '18+']].forEach(function (o) {
        opts.appendChild(h('button', { 'class': 'llx-opt', type: 'button', text: o[0], on: { click: function () {
          if (o[1] === 'u13') { write(UNDER13_KEY, { at: Date.now() }); self.render('under13'); self.emit(); return; }
          f.age = o[1]; self.render('email');
        } } }));
      });
      c.appendChild(opts);
      return;
    }

    if (step === 'under13') {
      c.appendChild(close);
      c.appendChild(h('h2', { text: 'Keep playing as a guest' }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'Accounts are for players 13 and older. Everything you do is still saved on this device, and every game stays free.' }));
      c.appendChild(h('button', { 'class': 'llx-btn', type: 'button', text: 'Back to the game', on: { click: function () { self.close(); } } }));
      return;
    }

    if (step === 'email') {
      c.appendChild(close);
      c.appendChild(h('h2', { text: 'Your email' }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'We will email you a six-digit code. No password, ever. Your email is never shown to other players.' }));
      var em = h('input', { 'class': 'llx-in', type: 'email', inputmode: 'email', autocomplete: 'email', autocapitalize: 'off', spellcheck: 'false',
        placeholder: 'you@example.com', 'aria-label': 'Email address', value: f.email || read(EMAIL_KEY) || '' });
      var send = h('button', { 'class': 'llx-btn', type: 'button', text: 'Send my code' });
      function go() {
        var v = (em.value || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { fail('That email address does not look right.'); return; }
        send.disabled = true; send.textContent = 'Sending…'; fail('');
        self.sendCode(v).then(function (r) {
          send.disabled = false; send.textContent = 'Send my code';
          if (!r.ok) { fail(r.error); return; }
          f.email = v; f.sentAt = Date.now(); self.render('code');
        });
      }
      send.addEventListener('click', go);
      em.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
      c.appendChild(em); c.appendChild(send); c.appendChild(err);
      c.appendChild(h('button', { 'class': 'llx-btn llx-ghost', type: 'button', text: 'Back', on: { click: function () { self.render('age'); } } }));
      setTimeout(function () { try { em.focus(); } catch (e) {} }, 50);
      return;
    }

    if (step === 'code') {
      c.appendChild(close);
      c.appendChild(h('h2', { text: 'Enter the code' }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'We sent a six-digit code to ' + f.email + '. It can take a minute to arrive; check spam too.' }));
      var code = h('input', { 'class': 'llx-in llx-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]*', 'aria-label': 'Six-digit code' });
      var ok = h('button', { 'class': 'llx-btn', type: 'button', text: 'Sign in' });
      function verify() {
        var v = (code.value || '').replace(/\D/g, '');
        if (v.length !== 6) { fail('The code has six digits.'); return; }
        ok.disabled = true; ok.textContent = 'Checking…'; fail('');
        self.verifyCode(f.email, v).then(function (r) {
          ok.disabled = false; ok.textContent = 'Sign in';
          if (!r.ok) { fail(r.error); return; }
          if (self.player) { self.afterSignIn(); self.render('account'); }
          else self.render('name');
        });
      }
      code.addEventListener('input', function () { code.value = code.value.replace(/\D/g, '').slice(0, 6); if (code.value.length === 6) verify(); });
      ok.addEventListener('click', verify);
      var resend = h('button', { 'class': 'llx-btn llx-ghost', type: 'button', text: 'Send a new code' });
      resend.addEventListener('click', function () {
        var wait = 60 - Math.floor((Date.now() - (f.sentAt || 0)) / 1000);
        if (wait > 0) { fail('You can ask for a new code in ' + wait + ' seconds.'); return; }
        self.sendCode(f.email).then(function (r) { if (r.ok) { f.sentAt = Date.now(); fail('A new code is on its way.'); } else fail(r.error); });
      });
      c.appendChild(code); c.appendChild(ok); c.appendChild(err); c.appendChild(resend);
      c.appendChild(h('button', { 'class': 'llx-btn llx-ghost', type: 'button', text: 'Use a different email', on: { click: function () { self.render('email'); } } }));
      setTimeout(function () { try { code.focus(); } catch (e) {} }, 50);
      return;
    }

    if (step === 'name') {
      if (!f.age) { self.render('age2'); return; }
      c.appendChild(h('h2', { text: 'Pick your name' }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'This is what other players see. A stone and a creature; you can change it later.' }));
      var list = h('div', { 'class': 'llx-opts' });
      var pick = h('button', { 'class': 'llx-btn', type: 'button', text: 'Use this name', disabled: 'disabled' });
      var chosen = null;
      function fill() {
        list.innerHTML = '';
        list.appendChild(h('p', { 'class': 'llx-soft', text: 'Finding names…' }));
        self.nameOptions().then(function (names) {
          list.innerHTML = '';
          if (!names.length) { list.appendChild(h('p', { 'class': 'llx-err', text: 'Could not load names. Check your connection.' })); return; }
          names.forEach(function (n) {
            var b = h('button', { 'class': 'llx-opt', type: 'button', 'aria-pressed': 'false', text: n });
            b.addEventListener('click', function () {
              chosen = n; pick.disabled = false;
              Array.prototype.forEach.call(list.children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
            });
            list.appendChild(b);
          });
        });
      }
      pick.addEventListener('click', function () {
        if (!chosen) return;
        pick.disabled = true; pick.textContent = 'Saving…';
        var av = f.avatar || [0, 0];
        self.createPlayer(chosen, f.age, av[0], av[1]).then(function (r) {
          pick.disabled = false; pick.textContent = 'Use this name';
          if (!r.ok) { fail(r.error); return; }
          self.afterSignIn(); self.render('account');
        });
      });
      c.appendChild(list);
      c.appendChild(h('button', { 'class': 'llx-btn llx-ghost', type: 'button', text: 'Show other names', on: { click: fill } }));
      c.appendChild(pick); c.appendChild(err);
      fill();
      return;
    }

    if (step === 'age2') {
      // Signed in on another game or device but no player record yet.
      c.appendChild(h('h2', { text: 'One question first' }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'How old are you?' }));
      var o2 = h('div', { 'class': 'llx-opts' });
      [['Under 13', 'u13'], ['13 to 17', '13-17'], ['18 or older', '18+']].forEach(function (o) {
        o2.appendChild(h('button', { 'class': 'llx-opt', type: 'button', text: o[0], on: { click: function () {
          if (o[1] === 'u13') { write(UNDER13_KEY, { at: Date.now() }); self.signOut(); self.render('under13'); return; }
          f.age = o[1]; self.render('name');
        } } }));
      });
      c.appendChild(o2);
      return;
    }

    if (step === 'account') {
      var pl = this.player || {};
      c.appendChild(close);
      c.appendChild(h('h2', { text: 'Your account' }));
      c.appendChild(h('p', { 'class': 'llx-name', text: pl.name + ' #' + String(pl.number || 0).padStart(4, '0') }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'Signed in as ' + ((this.session && this.session.user && this.session.user.email) || 'you') +
        '. Your progress is saved to this account, on every Lucid Lux game.' }));
      c.appendChild(h('p', { 'class': 'llx-soft llx-small', text: (this.me && this.me.badges ? this.me.badges.length : 0) + ' badges earned.' }));
      c.appendChild(h('button', { 'class': 'llx-btn llx-ghost', type: 'button', text: 'Change my name', on: { click: function () { self.render('rename'); } } }));
      c.appendChild(h('button', { 'class': 'llx-btn llx-ghost', type: 'button', text: 'Sign out on this device', on: { click: function () { self.signOut().then(function () { self.close(); }); } } }));
      c.appendChild(h('button', { 'class': 'llx-btn llx-danger', type: 'button', text: 'Delete my account', on: { click: function () { self.render('delete'); } } }));
      c.appendChild(h('button', { 'class': 'llx-btn', type: 'button', text: 'Done', on: { click: function () { self.close(); } } }));
      return;
    }

    if (step === 'rename') {
      c.appendChild(h('h2', { text: 'Change my name' }));
      var l2 = h('div', { 'class': 'llx-opts' });
      self.nameOptions().then(function (names) {
        names.forEach(function (n) {
          l2.appendChild(h('button', { 'class': 'llx-opt', type: 'button', text: n, on: { click: function () {
            self.updatePlayer({ name: n }).then(function () { self.render('account'); });
          } } }));
        });
      });
      c.appendChild(l2);
      c.appendChild(h('button', { 'class': 'llx-btn llx-ghost', type: 'button', text: 'Show other names', on: { click: function () { self.render('rename'); } } }));
      c.appendChild(h('button', { 'class': 'llx-btn llx-ghost', type: 'button', text: 'Keep my name', on: { click: function () { self.render('account'); } } }));
      return;
    }

    if (step === 'delete') {
      c.appendChild(h('h2', { text: 'Delete your account?' }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'This removes your name, saved progress, scores and badges from Lucid Lux for good. The games keep working as a guest on this device. This cannot be undone.' }));
      var del = h('button', { 'class': 'llx-btn llx-danger', type: 'button', text: 'Yes, delete everything' });
      del.addEventListener('click', function () {
        del.disabled = true; del.textContent = 'Deleting…';
        self.deleteAccount().then(function (r) {
          if (!r.ok) { del.disabled = false; del.textContent = 'Yes, delete everything'; fail(r.error); return; }
          try { localStorage.removeItem(self.revKey || ''); } catch (e) {}
          self.render('deleted');
        });
      });
      c.appendChild(del); c.appendChild(err);
      c.appendChild(h('button', { 'class': 'llx-btn', type: 'button', text: 'Keep my account', on: { click: function () { self.render('account'); } } }));
      return;
    }

    if (step === 'deleted') {
      c.appendChild(h('h2', { text: 'Account deleted' }));
      c.appendChild(h('p', { 'class': 'llx-soft', text: 'Everything Lucid Lux held about you is gone. You are playing as a guest on this device.' }));
      c.appendChild(h('button', { 'class': 'llx-btn', type: 'button', text: 'Back to the game', on: { click: function () { self.close(); } } }));
      return;
    }
  };

  /** After a fresh sign-in: line up this device's save with the account's. */
  Account.prototype.afterSignIn = function () {
    var self = this;
    this.reconcile().then(function (how) { if (self.onSynced) self.onSynced(how); });
  };

  /** A finished Batduko cave or Resonant round (TapBoom uses submitRun). */
  Account.prototype.submitResult = function (r) {
    var self = this;
    if (!this.session || !this.player) return Promise.resolve({ ok: false, reason: 'signed_out' });
    return this.rpc('ll_submit_result', {
      p_game: this.game, p_kind: r.kind, p_level: r.level | 0, p_score: Math.round(r.score || 0),
      p_duration_ms: Math.round(r.durationMs || 0), p_won: r.won !== false, p_version: r.version || null,
    }).then(function (res) {
      var d = res.ok && res.data ? res.data : { ok: false, reason: res.offline ? 'offline' : 'error' };
      if (d.ok && d.new_badges && d.new_badges.length && self.me) {
        d.new_badges.forEach(function (b) { if (self.me.badges.indexOf(b.slug) < 0) self.me.badges.push(b.slug); });
        self.emit();
      }
      return d;
    });
  };

  // ------------------------------------------------------------- the button
  //
  // One visible way in on every page: "Sign in" for a guest, the player's
  // name once signed in. Tapping it opens the panel.

  var BTN_CSS = [
    '.llx-pill{position:fixed;z-index:9000;display:inline-flex;align-items:center;gap:8px;min-height:44px;padding:0 16px;border-radius:999px;',
    'font:600 16px/1 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;cursor:pointer;',
    'background:#FFFFFF;color:#17171B;border:2px solid rgba(23,23,27,.18);box-shadow:0 6px 20px rgba(0,0,0,.28);-webkit-tap-highlight-color:transparent}',
    '.llx-pill.dark{background:#17161D;color:#F3F1F7;border-color:rgba(243,241,247,.25)}',
    '.llx-pill .dot{width:10px;height:10px;border-radius:50%;background:#E24B4B;flex:none}',
    '.llx-pill.in .dot{background:#2BD46B}',
    '.llx-pill.inline{position:static;box-shadow:none}',
    '.llx-pill.compact{flex-direction:column;justify-content:center;gap:4px;width:56px;min-height:56px;padding:6px 4px;border-radius:14px;font-size:11px;line-height:1.1;text-align:center}',
    '.llx-pill.compact span:last-child{max-width:52px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.llx-toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:9500;',
    'max-width:min(92vw,420px);padding:12px 16px;border-radius:14px;background:#17171B;color:#FFFFFF;text-align:center;',
    'font:650 16px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.35);pointer-events:none}',
  ].join('');

  function ensureCss(id, css) {
    if (document.getElementById(id)) return;
    var s = document.createElement('style'); s.id = id; s.textContent = css; document.head.appendChild(s);
  }

  var POS = {
    'top-right':    'top:calc(10px + env(safe-area-inset-top,0px));right:calc(10px + env(safe-area-inset-right,0px))',
    'top-left':     'top:calc(10px + env(safe-area-inset-top,0px));left:calc(10px + env(safe-area-inset-left,0px))',
    'bottom-right': 'bottom:calc(10px + env(safe-area-inset-bottom,0px));right:calc(10px + env(safe-area-inset-right,0px))',
    'bottom-left':  'bottom:calc(10px + env(safe-area-inset-bottom,0px));left:calc(10px + env(safe-area-inset-left,0px))',
    'left-middle':  'top:50%;transform:translateY(-50%);left:calc(8px + env(safe-area-inset-left,0px))',
  };

  Account.prototype.mountButton = function (opts) {
    var self = this;
    opts = opts || {};
    ensureCss('llx-btn-css', BTN_CSS);
    var b = h('button', { 'class': 'llx-pill' + (opts.dark ? ' dark' : '') + (opts.into ? ' inline' : '') + (opts.compact ? ' compact' : ''), type: 'button', id: opts.id || null });
    if (!opts.into) b.setAttribute('style', POS[opts.position || 'top-right'] || POS['top-right']);
    var dot = h('span', { 'class': 'dot', 'aria-hidden': 'true' });
    var label = h('span', {});
    b.appendChild(dot); b.appendChild(label);
    function paint() {
      var p = self.player;
      label.textContent = p ? (opts.compact ? p.name.split(' ')[0] : p.name) : (self.signedIn ? (opts.compact ? 'Finish' : 'Finish signing in') : 'Sign in');
      b.classList.toggle('in', !!p);
      b.setAttribute('aria-label', p ? 'Your Lucid Lux account: ' + p.name : 'Sign in or create a Lucid Lux account');
    }
    b.addEventListener('click', function (e) { e.stopPropagation(); self.open({ avatar: opts.avatar || [0, 0] }); });
    ['pointerdown', 'touchstart', 'mousedown'].forEach(function (t) { b.addEventListener(t, function (e) { e.stopPropagation(); }); });
    this.on(paint);
    paint();
    (opts.into || document.body).appendChild(b);
    this.button = b;
    return b;
  };

  Account.prototype.toast = function (text, ms) {
    ensureCss('llx-btn-css', BTN_CSS);
    var t = document.getElementById('llx-toast');
    if (!t) { t = h('div', { id: 'llx-toast', 'class': 'llx-toast', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(t); }
    t.textContent = text; t.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(function () { t.hidden = true; }, ms || 4200);
  };

  /**
   * Everything a game needs in one call: the button, save sync over a list of
   * localStorage keys, and results reported with
   *   window.dispatchEvent(new CustomEvent('lucidlux:result', { detail: { kind, level, score, durationMs, won } }))
   */
  function attach(o) {
    o = o || {};
    var a = create({ game: o.game });
    var keys = o.keys || [];
    if (keys.length) {
      a.useSave({
        collect: function () {
          var out = {};
          keys.forEach(function (k) { var v = null; try { v = JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { v = null; } out[k] = v; });
          return { v: 1, game: o.game, keys: out };
        },
        apply: function (st) {
          keys.forEach(function (k) {
            try { var v = st && st.keys ? st.keys[k] : null; if (v === null || v === undefined) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
          });
          try { sessionStorage.setItem('lucidlux.synced', '1'); } catch (e) {}
          location.reload();
        },
        progress: o.progress || function (st) { return st && st.keys ? JSON.stringify(st.keys).length : 0; },
      });
      a.onSynced = function (how) { if (how === 'uploaded') a.toast('Your progress is saved to your account.'); };
    }
    try {
      if (sessionStorage.getItem('lucidlux.synced')) {
        sessionStorage.removeItem('lucidlux.synced');
        setTimeout(function () { a.toast('Progress loaded from your account.'); }, 600);
      }
    } catch (e) {}
    if (o.game) {
      global.addEventListener('lucidlux:result', function (ev) {
        var d = (ev && ev.detail) || {};
        a.submitResult({ kind: d.kind, level: d.level, score: d.score, durationMs: d.durationMs, won: d.won, version: o.version })
          .then(function (r) {
            if (r && r.ok && r.new_badges && r.new_badges.length) {
              a.toast((r.new_badges.length === 1 ? 'Badge earned: ' : 'Badges earned: ') + r.new_badges.map(function (b) { return b.name; }).join(', '));
            }
            if (keys.length) a.push();
          });
      });
    }
    if (o.button !== false) {
      var mount = function () { a.mountButton(o.button || {}); };
      if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
    }
    if (a.session) a.refresh().then(function () { if (a.player && keys.length) a.reconcile(); });
    return a;
  }

  function create(o) {
    var a = new Account(o && Object.prototype.hasOwnProperty.call(o, 'game') ? o.game : 'tapboom');
    if (a.session) a.refresh();
    return a;
  }

  global.LucidLuxAccount = {
    create: create,
    attach: attach,
    config: CONFIG,
  };
})(typeof window !== 'undefined' ? window : this);
