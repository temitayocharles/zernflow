import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Data Deletion Instructions",
  description: "Instructions for disconnecting provider access and requesting data deletion.",
};

export default function DataDeletionPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16 text-gray-800">
      <Link href="/" className="text-sm font-medium text-indigo-600 hover:underline">
        ← Back to ZernFlow
      </Link>
      <h1 className="mt-8 text-3xl font-bold text-gray-950">Data Deletion Instructions</h1>
      <p className="mt-3 text-sm text-gray-500">Last updated: August 9, 2026</p>

      <div className="mt-10 space-y-8 leading-7">
        <section>
          <h2 className="text-xl font-semibold text-gray-950">Disconnect a social account</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-6">
            <li>Sign in to this ZernFlow deployment.</li>
            <li>Open the Channels workspace.</li>
            <li>Select the connected provider account you want to stop using.</li>
            <li>Use the available disconnect or remove action and confirm the request.</li>
            <li>
              Where applicable, you may also revoke this app from the connected provider&apos;s own
              account or business settings.
            </li>
          </ol>
          <p className="mt-3">
            Disconnecting prevents this deployment from continuing to use that provider connection.
            Provider-side revocation remains subject to the provider&apos;s own controls and retention
            rules.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Request deletion of deployment data</h2>
          <p className="mt-2">
            If you also want data stored by this deployment removed, send a deletion request through
            the normal support/contact channel for the operator of the account that gave you access.
            Include the email address used to sign in and enough information to identify the
            workspace or connected account. Do not send passwords, OAuth tokens, API keys, or other
            secrets with the request.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">What the request covers</h2>
          <p className="mt-2">
            A verified deletion request can cover account/workspace information, connected-provider
            metadata, local conversation or automation records, and provider credentials held for
            the connection. Some security, audit, backup, or transaction records may remain for the
            minimum period required to preserve system integrity or comply with applicable
            obligations, after which they can be removed or expire according to the deployment&apos;s
            retention process.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Protect your credentials</h2>
          <p className="mt-2">
            Never include provider access tokens, app secrets, passwords, or Vault credentials in a
            deletion request. The operator may ask for non-secret account identifiers to verify the
            request before deleting data.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Related policy</h2>
          <Link href="/privacy" className="mt-2 inline-block font-medium text-indigo-600 hover:underline">
            Read the Privacy Policy
          </Link>
        </section>
      </div>
    </main>
  );
}
