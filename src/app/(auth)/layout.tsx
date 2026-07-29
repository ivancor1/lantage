/**
 * Layout for the unauthenticated routes. Centres a single card on the app's
 * off-black ground — no nav, no map shell, nothing to click but the form.
 */

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5 py-16">
      <div className="w-full max-w-[420px]">{children}</div>
    </main>
  );
}
