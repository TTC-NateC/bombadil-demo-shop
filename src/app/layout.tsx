import type { Metadata } from "next";
import Link from "next/link";
import { CartBadge } from "@/components/CartBadge";
import "./globals.css";

export const metadata: Metadata = {
  title: "Demo Shop",
  description: "A demo storefront built around a pricing engine.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <header className="border-b border-neutral-200 dark:border-neutral-800">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              Demo Shop
            </Link>
            <CartBadge />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
