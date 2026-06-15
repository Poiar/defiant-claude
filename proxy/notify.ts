'use strict';

// Desktop notifications for budget threshold breaches.
// Cross-platform: Linux (notify-send), macOS (osascript), Windows (PowerShell toast).
// Failures are silent — notification errors never crash the proxy.

import { exec } from 'child_process';

const firedThresholds = new Set<number>();

/** Reset fired thresholds (for testing). */
export function _resetFiredThresholds(): void {
  firedThresholds.clear();
}

/** Send a desktop notification. Errors are swallowed silently. */
export function sendNotification(title: string, message: string): void {
  const escapedTitle = title.replace(/"/g, '\\"');
  const escapedMessage = message.replace(/"/g, '\\"');

  let cmd: string;
  if (process.platform === 'linux') {
    cmd = `notify-send "${escapedTitle}" "${escapedMessage}"`;
  } else if (process.platform === 'darwin') {
    cmd = `osascript -e 'display notification "${escapedMessage}" with title "${escapedTitle}"'`;
  } else if (process.platform === 'win32') {
    // PowerShell toast via BurntToast module or fallback to a simple balloon
    cmd = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.BalloonTipTitle = '${escapedTitle}'; $n.BalloonTipText = '${escapedMessage}'; $n.Visible = $true; $n.ShowBalloonTip(5000); Start-Sleep -Seconds 6; $n.Dispose()"`;
  } else {
    return;
  }

  exec(cmd, { timeout: 5000 }, () => {
    /* ignore all output and errors */
  });
}

/**
 * Check if any budget warning threshold has been breached for the first time.
 * Thresholds are percentages parsed from DEEPCLAUDE_BUDGET_WARNING (e.g. "50,75,100").
 * Returns true if a notification was sent.
 */
export function checkBudgetNotifications(
  currentSpend: number,
  budgetCap: number,
  budgetLabel: string,
): boolean {
  const warnEnv = process.env.DEEPCLAUDE_BUDGET_WARNING;
  if (!warnEnv || budgetCap <= 0) return false;

  const thresholds = warnEnv
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0 && n <= 100);
  if (!thresholds.length) return false;

  const pct = (currentSpend / budgetCap) * 100;
  let notified = false;

  for (const threshold of thresholds) {
    if (pct >= threshold && !firedThresholds.has(threshold)) {
      firedThresholds.add(threshold);
      const title =
        threshold >= 100
          ? 'DeepClaude: Budget exhausted'
          : `DeepClaude: ${threshold}% of budget used`;
      const msg =
        `$${currentSpend.toFixed(2)} of $${budgetCap.toFixed(2)} spent ` +
        `(${threshold}% of ${budgetLabel})`;
      sendNotification(title, msg);
      notified = true;
    }
  }

  return notified;
}
