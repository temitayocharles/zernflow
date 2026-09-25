import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  Inbox,
  Megaphone,
  ShieldCheck,
  Users,
  Workflow,
  Server,
  ClipboardCheck,
} from "lucide-react";

/**
 * ZernFlow-native landing page. Replaced the upstream marketing page, which
 * linked to a third-party repository, carried a hosted-vendor badge and
 * compared itself against another product (removal manifest §1). The source
 * link is deployment configuration: set NEXT_PUBLIC_SOURCE_URL to show it.
 */
const PILLARS = [
  {
    icon: Megaphone,
    title: "Campaigns that keep running",
    body: "Plan a campaign once and let its content, automations and follow-ups execute over days or weeks, with every step recorded.",
  },
  {
    icon: CalendarClock,
    title: "Publishing and scheduling",
    body: "Draft, schedule and track posts per channel. Each attempt has a clear state, a receipt, and a retry you control.",
  },
  {
    icon: Workflow,
    title: "Comment and DM automations",
    body: "Visual flows for replies, keyword triggers, delays and sequences, sent through your own provider gateway.",
  },
  {
    icon: Inbox,
    title: "One inbox",
    body: "Conversations from every connected channel in one queue, with assignment, SLAs and human takeover.",
  },
  {
    icon: Users,
    title: "Customer 360",
    body: "Contacts, tags, custom fields, first and last touch, and campaign attribution in one profile.",
  },
  {
    icon: ClipboardCheck,
    title: "Approvals and operations",
    body: "Autonomous where you allow it, human-approved where you need it. Jobs, retries and audit history are visible to owners.",
  },
];

const PRINCIPLES = [
  { icon: Server, text: "Self-hosted on infrastructure you control, sized for free tiers. Queues wait instead of scaling up." },
  { icon: ShieldCheck, text: "Official APIs first, provider adapters second, managed browser sessions last and only where you opt in." },
  { icon: ShieldCheck, text: "Secrets are envelope-encrypted and never shown back; CAPTCHA and MFA always go to a human." },
];

export default function Home() {
  const sourceUrl = process.env.NEXT_PUBLIC_SOURCE_URL?.trim();
  return (
    <div className="min-h-screen bg-white">
      <nav className="sticky top-0 z-50 border-b border-gray-100 bg-white/80 backdrop-blur-lg">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2">
            <Image src="/logo.png" alt="ZernFlow" width={28} height={28} className="rounded-lg" />
            <span className="text-base font-bold text-gray-900">ZernFlow</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/login" className="rounded-lg px-3 py-2 text-sm text-gray-500 hover:text-gray-900">
              Log in
            </Link>
            <Link
              href="/register"
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Create workspace
            </Link>
          </div>
        </div>
      </nav>

      <main>
        <section className="mx-auto max-w-6xl px-6 pb-16 pt-20 sm:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <p className="mb-5 inline-flex rounded-full border border-indigo-100 bg-indigo-50 px-4 py-1.5 text-xs font-medium text-indigo-700">
              Self-hosted creator operating system
            </p>
            <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
              Run campaigns, publishing, automations and customers from one place
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-gray-500">
              ZernFlow brings content planning, scheduled publishing, comment and DM automation, a shared inbox and a
              customer CRM into a single workspace that you host and own.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href="/register"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-6 py-3 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 sm:w-auto"
              >
                Create a workspace <ArrowRight className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/login"
                className="inline-flex w-full items-center justify-center rounded-lg border border-gray-200 bg-white px-6 py-3 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 sm:w-auto"
              >
                Log in
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-gray-100 bg-gray-50/60 py-16">
          <div className="mx-auto grid max-w-6xl gap-6 px-6 sm:grid-cols-2 lg:grid-cols-3">
            {PILLARS.map(({ icon: Icon, title, body }) => (
              <div key={title} className="rounded-xl border border-gray-200 bg-white p-6">
                <Icon className="h-5 w-5 text-indigo-600" aria-hidden />
                <h2 className="mt-3 text-base font-semibold text-gray-900">{title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-gray-500">{body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="py-16">
          <div className="mx-auto max-w-3xl px-6">
            <h2 className="text-center text-2xl font-bold text-gray-900">How it runs</h2>
            <ul className="mt-8 space-y-4">
              {PRINCIPLES.map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-start gap-3 text-sm text-gray-600">
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" aria-hidden />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>

      <footer className="border-t border-gray-100 py-8">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 text-sm text-gray-400 sm:flex-row">
          <div className="flex items-center gap-4">
            <span>ZernFlow</span>
            <Link href="/terms" className="hover:text-gray-600">
              Terms
            </Link>
            <Link href="/privacy" className="hover:text-gray-600">
              Privacy
            </Link>
            {sourceUrl && (
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:text-gray-600">
                Source
              </a>
            )}
          </div>
          <p className="text-xs">Open source, MIT licensed</p>
        </div>
      </footer>
    </div>
  );
}
