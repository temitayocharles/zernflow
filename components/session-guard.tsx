"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  SESSION_INACTIVITY_TIMEOUT_MS,
  isSessionInactive,
} from "@/lib/auth/session-policy";

const LAST_ACTIVITY_KEY = "zernflow_last_activity_at";
const SESSION_USER_KEY = "zernflow_session_user_id";
const ACTIVITY_WRITE_THROTTLE_MS = 60_000;

export function SessionGuard({ userId }: { userId: string }) {
  useEffect(() => {
    const supabase = createClient();
    let lastWrite = 0;
    let signingOut = false;

    const storedUser = localStorage.getItem(SESSION_USER_KEY);
    if (storedUser !== userId) {
      localStorage.setItem(SESSION_USER_KEY, userId);
      localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
    }

    const recordActivity = () => {
      const now = Date.now();
      if (now - lastWrite < ACTIVITY_WRITE_THROTTLE_MS) return;
      lastWrite = now;
      localStorage.setItem(LAST_ACTIVITY_KEY, String(now));
    };

    const enforceInactivity = async () => {
      if (signingOut) return;
      const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
      const lastActivity = raw ? Number(raw) : null;
      if (!isSessionInactive(lastActivity)) return;

      signingOut = true;
      localStorage.removeItem(LAST_ACTIVITY_KEY);
      localStorage.removeItem(SESSION_USER_KEY);
      await supabase.auth.signOut();
      window.location.assign("/login?reason=inactive");
    };

    const events: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "touchstart",
      "focus",
    ];
    events.forEach((event) => window.addEventListener(event, recordActivity, { passive: true }));
    document.addEventListener("visibilitychange", recordActivity);

    recordActivity();
    const interval = window.setInterval(enforceInactivity, 60_000);
    void enforceInactivity();

    const { data: authListener } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        localStorage.removeItem(LAST_ACTIVITY_KEY);
        localStorage.removeItem(SESSION_USER_KEY);
      }
    });

    return () => {
      window.clearInterval(interval);
      events.forEach((event) => window.removeEventListener(event, recordActivity));
      document.removeEventListener("visibilitychange", recordActivity);
      authListener.subscription.unsubscribe();
    };
  }, [userId]);

  return null;
}
