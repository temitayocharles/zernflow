import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Privacy information for this self-hosted ZernFlow deployment.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-16 text-gray-800">
      <Link href="/" className="text-sm font-medium text-indigo-600 hover:underline">
        ← Back to ZernFlow
      </Link>
      <h1 className="mt-8 text-3xl font-bold text-gray-950">Privacy Policy</h1>
      <p className="mt-3 text-sm text-gray-500">Last updated: August 9, 2026</p>

      <div className="mt-10 space-y-8 leading-7">
        <section>
          <h2 className="text-xl font-semibold text-gray-950">About this deployment</h2>
          <p className="mt-2">
            This is a self-hosted deployment based on the MIT-licensed ZernFlow project. It uses a
            self-hosted Agent Social Gateway to connect supported social platforms and to keep
            provider credentials on the server side.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Information processed</h2>
          <p className="mt-2">
            The service may process account and workspace information, connected-provider account
            identifiers and profile metadata, messages, comments, delivery events, automation
            settings, operational logs, and other data needed to provide inbox, workflow, and
            messaging features. OAuth tokens and provider credentials are handled by the Gateway
            and its server-side credential store rather than being returned to the browser as
            application data.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">How information is used</h2>
          <p className="mt-2">
            Information is processed to authenticate users, connect requested provider accounts,
            display and route conversations, run configured automations, send requested actions,
            maintain delivery state, troubleshoot failures, and preserve security and audit
            records.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Provider and infrastructure access</h2>
          <p className="mt-2">
            Data is sent to connected social providers when required to perform actions requested
            through this deployment. The service also relies on infrastructure used to host the
            application, database, and credential storage. Each connected provider remains subject
            to its own terms and privacy practices.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Retention and deletion</h2>
          <p className="mt-2">
            Operational data is retained as needed to provide the service, maintain message and
            automation state, and support security and audit requirements. Connected accounts can
            be disconnected, and deletion requests can be made using the published data-deletion
            instructions.
          </p>
          <Link href="/data-deletion" className="mt-3 inline-block font-medium text-indigo-600 hover:underline">
            View data-deletion instructions
          </Link>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-gray-950">Policy changes</h2>
          <p className="mt-2">
            This notice may be updated when the deployment, provider integrations, or data-handling
            practices materially change. The current version is published at this URL.
          </p>
        </section>
      </div>
    </main>
  );
}
