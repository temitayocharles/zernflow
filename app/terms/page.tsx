import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Use",
  description: "Terms for this self-hosted ZernFlow deployment.",
};

export default function TermsPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16 text-gray-800">
      <Link href="/" className="text-sm font-medium text-indigo-600 hover:underline">
        ← Back to ZernFlow
      </Link>
      <h1 className="mt-8 text-3xl font-bold text-gray-950">Terms of Use</h1>
      <p className="mt-3 text-sm text-gray-500">Last updated: August 9, 2026</p>

      <div className="mt-10 space-y-8 leading-7">
        <section>
          <h2 className="text-xl font-semibold text-gray-950">Service</h2>
          <p className="mt-2">
            This deployment provides a self-hosted social messaging, inbox, and automation service
            based on the MIT-licensed ZernFlow project and a self-hosted Agent Social Gateway.
            Features may change as the deployment is developed and provider capabilities evolve.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Authorized use</h2>
          <p className="mt-2">
            Use the service only with accounts, workspaces, data, and provider permissions that you
            are authorized to access. Do not use it to violate applicable law, abuse provider APIs,
            bypass platform restrictions, impersonate another person, or send prohibited content.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Connected providers</h2>
          <p className="mt-2">
            Facebook, Instagram, WhatsApp, and other connected platforms remain governed by their
            own terms, API permissions, rate limits, messaging windows, review requirements, and
            technical restrictions. This deployment cannot grant capabilities that a provider does
            not authorize.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Account security</h2>
          <p className="mt-2">
            Keep account credentials secure and promptly disconnect provider access that should no
            longer be active. Provider secrets and OAuth credentials are intended to remain on the
            server side through the Gateway credential boundary.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Availability</h2>
          <p className="mt-2">
            The service is provided on an operational best-effort basis. Provider outages, API
            changes, infrastructure failures, account restrictions, or maintenance can temporarily
            affect availability or individual capabilities.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Open-source attribution</h2>
          <p className="mt-2">
            ZernFlow remains subject to its MIT license and upstream copyright notice. The
            self-hosted deployment and Agent Social Gateway integration do not imply endorsement by
            Zernio or by any connected social provider.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Privacy and deletion</h2>
          <p className="mt-2">
            Review the published privacy notice and data-deletion instructions for information about
            data handling and removal requests.
          </p>
          <div className="mt-3 flex gap-4">
            <Link href="/privacy" className="font-medium text-indigo-600 hover:underline">
              Privacy Policy
            </Link>
            <Link href="/data-deletion" className="font-medium text-indigo-600 hover:underline">
              Data Deletion
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
