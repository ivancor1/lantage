'use client';

/**
 * Magic-link sign-in.
 *
 * No password field on purpose: a shared analyst password is the credential most
 * likely to end up in a group chat, and a magic link keeps the account bound to a
 * mailbox someone has to control. It also gives the audit trail a real identity
 * rather than "the SIU login".
 *
 * `shouldCreateUser: false`. Self-signup would be an anonymous tier with extra
 * steps — MASTER_PLAN §7 forbids one, so accounts are provisioned by an
 * administrator and this form only signs in accounts that already exist. The
 * response is deliberately identical whether or not the address is known, so the
 * form cannot be used to enumerate customers.
 */

import { createBrowserClient } from '@supabase/ssr';
import { useState } from 'react';

import { Button } from '@/components/ui/Button';

/**
 * The client is built here rather than imported from `@/lib/db/client`.
 *
 * That module exports both the browser and the server client from one file, and
 * the server one imports `next/headers` — so importing *anything* from it inside a
 * Client Component fails the Turbopack build ("You're importing a module that
 * depends on next/headers"). This is the only Client Component in the app that
 * needs Supabase, so a local constructor is cheaper than a refactor.
 *
 * TODO(A2): splitting `createBrowserSupabaseClient` into its own module (e.g.
 * `src/lib/db/browser.ts`) would let this import it and keep the credential
 * reading in one place.
 */
function browserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('Supabase publishable credentials are not configured.');
  }
  // Publishable key only. RLS is what protects the data, not the secrecy of this.
  return createBrowserClient(url, key);
}

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string };

export function MagicLinkForm({ next }: { next?: string }) {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (address.length === 0) return;

    setState({ kind: 'sending' });

    try {
      const supabase = browserClient();
      const callback = new URL('/auth/callback', window.location.origin);
      if (next) callback.searchParams.set('next', next);

      const { error } = await supabase.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: callback.toString(), shouldCreateUser: false },
      });

      // Even on error we report success. A distinguishable failure here tells an
      // attacker which addresses have Lantage accounts, which is a list of
      // investigators — the exact list not to publish. The real error is in the
      // Supabase auth logs.
      if (error) console.warn('[login] sign-in request failed:', error.message);
      setState({ kind: 'sent' });
    } catch {
      setState({
        kind: 'error',
        message: 'Could not reach the sign-in service. Check your connection and try again.',
      });
    }
  }

  if (state.kind === 'sent') {
    return (
      <div className="space-y-3" aria-live="polite">
        <p className="eyebrow-mono">CHECK YOUR EMAIL</p>
        <p className="text-sm text-fg-secondary">
          If an account exists for <span className="text-fg">{email.trim()}</span>, a sign-in link
          is on its way. The link is single-use and expires shortly.
        </p>
        <Button variant="ghost" onClick={() => setState({ kind: 'idle' })}>
          Use a different address
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="email" className="eyebrow-mono block">
          WORK EMAIL
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@agency.gov"
          className="h-11 w-full rounded-full border border-border-strong bg-n-0 px-4 text-base text-fg placeholder:text-fg-tertiary hover:border-n-400 focus-visible:border-n-400"
        />
      </div>

      {state.kind === 'error' && (
        <p role="alert" className="text-sm text-alert">
          {state.message}
        </p>
      )}

      <Button type="submit" variant="primary" className="w-full" disabled={state.kind === 'sending'}>
        {state.kind === 'sending' ? 'Sending link…' : 'Send sign-in link'}
      </Button>
    </form>
  );
}
