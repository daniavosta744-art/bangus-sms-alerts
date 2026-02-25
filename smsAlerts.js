// ========================================
// SMS ALERTS - TextBee Gateway Integration
// Bangus Pond Water Quality Monitor
// ========================================
// ALERT RULES:
//
//   WARNING entered        → SMS immediately, then every 5 mins while still warning
//   CRITICAL entered       → SMS immediately, then every 1 min while still critical
//   WARNING → CRITICAL     → SMS immediately (escalation), then every 1 min
//   CRITICAL → WARNING     → SMS immediately (downgrade), then every 5 mins
//   SAFE reached           → SMS once (recovery), intervals cleared
//
//   Severity changes always bypass any running interval and send immediately.
// ========================================


// ── CONFIG ───────────────────────────────────────────────────────────────────
const SMS_CONFIG = {
  apiKey:   'a01447de-9423-4c0d-bfcc-3459e2fe9075',    // From textbee.dev dashboard
  deviceId: '6995c765f8dad099dc719666',  // From textbee.dev dashboard
  baseUrl:  'https://api.textbee.dev/api/v1',

  // Phone numbers that will receive SMS alerts (Philippine format)
  recipients: [
    '+639686546079',
    // '+63XXXXXXXXXX', // Uncomment to add more
  ],

  // How often to repeat SMS while the parameter stays in each severity
  repeatIntervalMs: {
    warning:  5 * 60 * 1000,  // 5 minutes
    critical: 1 * 60 * 1000,  // 1 minute
  },

  // Send an SMS when a parameter returns to safe range
  sendRecoverySms: true,

  // Firebase path for SMS send logs (prevents duplicate sends on page reload)
  smsLogPath: 'smsAlerts/log',
};
// ─────────────────────────────────────────────────────────────────────────────


// ── STATE ─────────────────────────────────────────────────────────────────────
/*
  _paramState tracks per-parameter alert state:
  {
    [parameter]: {
      severity:    'warning' | 'critical' | null,
      alertId:     string,       // current Firebase alert ID
      value:       string,
      threshold:   string,
      message:     string,
      intervalId:  number|null,  // setInterval handle for repeat SMS
      lastSentAt:  number,       // timestamp of last SMS sent
    }
  }
*/
const _paramState = {};

// IDs already sent an SMS for (loaded from Firebase on init, survives reload)
const _sentAlertIds = new Set();

let _smsInitialized = false;
// ─────────────────────────────────────────────────────────────────────────────


// ── INIT ──────────────────────────────────────────────────────────────────────
function initSmsAlerts() {
  if (_smsInitialized) return;
  _smsInitialized = true;

  if (typeof firebase === 'undefined' || !firebase.database) {
    console.error('[SMS] Firebase not available. SMS alerts disabled.');
    return;
  }

  console.log('[SMS] Initializing SMS alert system...');

  // Load sent log first so we don't re-send on page reload, then watch alerts
  _loadSentLog().then(() => {
    _watchActiveAlerts();
    console.log('[SMS] SMS alert system ready.');
  });
}

/**
 * Load previously sent alert IDs from Firebase into _sentAlertIds.
 * Only last 500 entries to keep it lightweight.
 */
function _loadSentLog() {
  return firebase.database()
    .ref(SMS_CONFIG.smsLogPath)
    .orderByChild('sentAt')
    .limitToLast(500)
    .once('value')
    .then((snapshot) => {
      if (snapshot.exists()) {
        snapshot.forEach((child) => {
          const data = child.val();
          if (data && data.alertId) {
            _sentAlertIds.add(data.alertId);
          }
        });
        console.log(`[SMS] Loaded ${_sentAlertIds.size} previously sent alert IDs.`);
      }
    })
    .catch((err) => {
      console.warn('[SMS] Could not load SMS log (will continue without it):', err);
    });
}
// ─────────────────────────────────────────────────────────────────────────────


// ── FIREBASE LISTENER ────────────────────────────────────────────────────────
function _watchActiveAlerts() {
  const activeRef = firebase.database().ref('alerts/active');

  // child_added fires for existing nodes on first listen, then for truly new ones.
  // _sentAlertIds prevents re-sending for alerts that were active before page reload.
  activeRef.on('child_added', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertAddedOrChanged(alert, false);
  });

  // child_changed fires when alerts.js updates value/severity on an existing alert
  activeRef.on('child_changed', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertAddedOrChanged(alert, true);
  });

  // child_removed fires when an alert is acknowledged, dismissed, or auto-resolved
  activeRef.on('child_removed', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertRemoved(alert);
  });
}
// ─────────────────────────────────────────────────────────────────────────────


// ── CORE ALERT HANDLER ───────────────────────────────────────────────────────
/**
 * Called when an alert is added or its severity/value changes.
 * Decides whether to send immediately and how to schedule repeats.
 *
 * @param {object}  alert     - The alert data from Firebase
 * @param {boolean} isUpdate  - true if this is a child_changed event
 */
function _onAlertAddedOrChanged(alert, isUpdate) {
  const { id, parameter, severity, value, threshold, message } = alert;
  const prev = _paramState[parameter];

  const prevSeverity = prev ? prev.severity : null;
  const severityChanged = prevSeverity !== severity;

  // ── Case 1: Page reload — alert already existed before reload ───────────
  // _sentAlertIds has the ID but we have no interval running.
  // Restore state silently and restart the repeat interval without sending SMS.
  if (_sentAlertIds.has(id) && !prev) {
    console.log(`[SMS] Restoring state for "${parameter}" (${severity}) after reload.`);
    _paramState[parameter] = {
      severity, alertId: id, value, threshold, message,
      intervalId: null, lastSentAt: Date.now(),
    };
    _startRepeatInterval(parameter);
    return;
  }

  // ── Case 2: Same alert ID, same severity, value just updated ───────────
  // Update stored value/threshold but don't send — the interval handles repeats.
  if (prev && prev.alertId === id && !severityChanged) {
    prev.value     = value;
    prev.threshold = threshold;
    prev.message   = message;
    console.log(`[SMS] Value update for "${parameter}" (${severity}): ${value} — interval handles repeat.`);
    return;
  }

  // ── Case 3: Severity changed (escalation or downgrade) ─────────────────
  // OR brand new alert for this parameter.
  // Always send immediately and restart the interval for the new severity.
  const reason = !prev
    ? `entered ${severity}`
    : `changed ${prevSeverity} → ${severity}`;

  console.log(`[SMS] "${parameter}" ${reason}. Sending SMS immediately.`);

  // Clear any existing interval for this parameter
  _clearRepeatInterval(parameter);

  // Update state
  _paramState[parameter] = {
    severity, alertId: id, value, threshold, message,
    intervalId: null, lastSentAt: 0, // 0 forces send in _sendAlertSms
  };

  // Send immediately then start repeating
  _sendAlertSms(parameter, reason);
  _startRepeatInterval(parameter);
}

/**
 * Called when an alert is removed (resolved, acknowledged, or dismissed).
 */
function _onAlertRemoved(alert) {
  const { parameter } = alert;
  const prev = _paramState[parameter];

  // Clear the repeat interval immediately
  _clearRepeatInterval(parameter);
  delete _paramState[parameter];

  if (!SMS_CONFIG.sendRecoverySms) return;

  // Wait 3s to confirm the parameter isn't immediately re-alerting
  setTimeout(() => {
    firebase.database()
      .ref('alerts/active')
      .orderByChild('parameter')
      .equalTo(parameter)
      .once('value')
      .then((snap) => {
        if (!snap.exists()) {
          console.log(`[SMS] "${parameter}" returned to safe range. Sending recovery SMS.`);
          const smsBody = _buildRecoveryMessage(parameter);
          _sendSms(smsBody);
        } else {
          console.log(`[SMS] "${parameter}" re-alerted immediately — skipping recovery SMS.`);
        }
      });
  }, 3000);
}
// ─────────────────────────────────────────────────────────────────────────────


// ── INTERVAL MANAGEMENT ───────────────────────────────────────────────────────
/**
 * Start a repeating SMS interval based on the parameter's current severity.
 * CRITICAL = every 1 min, WARNING = every 5 mins.
 */
function _startRepeatInterval(parameter) {
  const state = _paramState[parameter];
  if (!state) return;

  const intervalMs = SMS_CONFIG.repeatIntervalMs[state.severity];
  if (!intervalMs) return;

  console.log(`[SMS] Starting repeat interval for "${parameter}" (${state.severity}): every ${intervalMs / 60000} min.`);

  state.intervalId = setInterval(() => {
    // Re-check state is still valid (could have been cleared by removal)
    const current = _paramState[parameter];
    if (!current) {
      clearInterval(state.intervalId);
      return;
    }

    // Verify the parameter is still at the same severity in Firebase before sending
    firebase.database()
      .ref('alerts/active')
      .orderByChild('parameter')
      .equalTo(parameter)
      .once('value')
      .then((snap) => {
        if (!snap.exists()) {
          // Alert was resolved between intervals
          _clearRepeatInterval(parameter);
          delete _paramState[parameter];
          return;
        }

        // Confirm severity hasn't changed since interval was set up
        let currentSeverity = null;
        snap.forEach((child) => { currentSeverity = child.val().severity; });

        if (currentSeverity !== current.severity) {
          // Severity changed — child_changed will handle it, skip this tick
          console.log(`[SMS] Severity changed for "${parameter}" during interval tick — skipping.`);
          return;
        }

        console.log(`[SMS] Repeat interval fired for "${parameter}" (${current.severity}).`);
        _sendAlertSms(parameter, `still ${current.severity}`);
      });
  }, intervalMs);
}

/**
 * Clear and nullify the repeat interval for a parameter.
 */
function _clearRepeatInterval(parameter) {
  const state = _paramState[parameter];
  if (state && state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
    console.log(`[SMS] Cleared repeat interval for "${parameter}".`);
  }
}
// ─────────────────────────────────────────────────────────────────────────────


// ── SMS SENDING ───────────────────────────────────────────────────────────────
/**
 * Build and send an alert SMS for a parameter, then log it.
 */
function _sendAlertSms(parameter, reason) {
  const state = _paramState[parameter];
  if (!state) return;

  const { severity, alertId, value, threshold, message } = state;
  const smsBody = _buildAlertMessage(parameter, severity, value, threshold, message, reason);

  _sendSms(smsBody).then((success) => {
    if (success) {
      state.lastSentAt = Date.now();
      _markAsSent(alertId, parameter, severity);
      console.log(`[SMS] ✅ Alert SMS sent for "${parameter}" (${severity}).`);
    }
  });
}

/**
 * Send an SMS via TextBee to all configured recipients.
 * Returns Promise<boolean>.
 */
async function _sendSms(message) {
  const { apiKey, deviceId, baseUrl, recipients } = SMS_CONFIG;

  if (!apiKey || apiKey === 'YOUR_TEXTBEE_API_KEY') {
    console.warn('[SMS] TextBee API key not configured.');
    return false;
  }
  if (!deviceId || deviceId === 'YOUR_TEXTBEE_DEVICE_ID') {
    console.warn('[SMS] TextBee device ID not configured.');
    return false;
  }
  if (!recipients || recipients.length === 0 || recipients[0] === '+63XXXXXXXXXX') {
    console.warn('[SMS] No recipients configured.');
    return false;
  }

  const url = `${baseUrl}/gateway/devices/${deviceId}/send-sms`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({ recipients, message }),
    });

    const data = await response.json();

    if (response.ok) {
      console.log('[SMS] ✅ SMS sent successfully:', data);
      return true;
    } else {
      console.error('[SMS] ❌ TextBee API error:', response.status, data);
      return false;
    }
  } catch (error) {
    console.error('[SMS] ❌ Network error:', error.message);
    return false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────


// ── MESSAGE BUILDERS ──────────────────────────────────────────────────────────
function _buildAlertMessage(parameter, severity, value, threshold, message, reason) {
  const paramLabel = _getParamLabel(parameter);
  const unit       = _getParamUnit(parameter);
  const sevLabel   = severity.toUpperCase();
  const time       = new Date().toLocaleString('en-PH', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // Context line describes WHY the SMS is being sent
  let contextLine = '';
  if (reason && reason.includes('→')) {
    contextLine = `Status changed: ${reason}\n`;
  } else if (reason && reason.startsWith('still')) {
    contextLine = `⚠️ Still ${severity} — situation ongoing.\n`;
  } else {
    contextLine = `Alert triggered.\n`;
  }

  return (
    `[BANGUS POND ALERT]\n` +
    `${sevLabel}: ${paramLabel}\n` +
    `${contextLine}` +
    `Current: ${value} ${unit}\n` +
    `Threshold: ${threshold}\n` +
    `${message ? message + '\n' : ''}` +
    `Time: ${time}\n` +
    `Check the monitoring dashboard.`
  ).trim();
}

function _buildRecoveryMessage(parameter) {
  const paramLabel = _getParamLabel(parameter);
  const time       = new Date().toLocaleString('en-PH', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  return (
    `[BANGUS POND - RESOLVED]\n` +
    `✅ ${paramLabel} has returned to safe range.\n` +
    `Time: ${time}`
  ).trim();
}

function _getParamLabel(parameter) {
  const labels = {
    do:          'Dissolved Oxygen (DO)',
    temperature: 'Temperature',
    salinity:    'Salinity',
    turbidity:   'Turbidity',
    ph:          'pH Level',
  };
  return labels[parameter?.toLowerCase()] || parameter?.toUpperCase() || 'Unknown';
}

function _getParamUnit(parameter) {
  const units = {
    do:          'mg/L',
    temperature: '°C',
    salinity:    'ppt',
    turbidity:   'NTU',
    ph:          '',
  };
  return units[parameter?.toLowerCase()] || '';
}
// ─────────────────────────────────────────────────────────────────────────────


// ── FIREBASE LOG HELPER ───────────────────────────────────────────────────────
/**
 * Record that an SMS was sent for this alert ID so it's skipped on page reload.
 */
function _markAsSent(alertId, parameter, severity) {
  _sentAlertIds.add(alertId);

  firebase.database()
    .ref(SMS_CONFIG.smsLogPath)
    .push({ alertId, parameter, severity, sentAt: Date.now() })
    .catch((err) => console.warn('[SMS] Could not write to SMS log:', err));
}
// ─────────────────────────────────────────────────────────────────────────────


// ── PUBLIC API ────────────────────────────────────────────────────────────────
/**
 * Send a test SMS to verify your TextBee setup.
 * Call from browser console: testSmsSend()
 */
function testSmsSend() {
  console.log('[SMS] Sending test SMS...');
  _sendSms(
    '[BANGUS POND - TEST]\n' +
    '✅ SMS alert system is working correctly.\n' +
    'This is a test message from your monitoring system.'
  ).then((success) => {
    if (success) console.log('[SMS] Test SMS sent! Check your phone.');
    else         console.error('[SMS] Test SMS failed. Check API key and device ID.');
  });
}

/**
 * Update recipients at runtime without reloading.
 * Example: setSmsRecipients(['+63912XXXXXXX'])
 */
function setSmsRecipients(numbers) {
  SMS_CONFIG.recipients = numbers;
  console.log('[SMS] Recipients updated:', numbers);
}

/**
 * View current per-parameter alert state (for debugging).
 * Call from browser console: getSmsState()
 */
function getSmsState() {
  console.table(
    Object.entries(_paramState).map(([param, s]) => ({
      parameter:    param,
      severity:     s.severity,
      value:        s.value,
      intervalActive: s.intervalId !== null,
      lastSentAgo:  s.lastSentAt ? Math.round((Date.now() - s.lastSentAt) / 1000) + 's ago' : 'never',
    }))
  );
}
// ─────────────────────────────────────────────────────────────────────────────


// ── AUTO-START ────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSmsAlerts);
} else {
  initSmsAlerts();
}

console.log('[SMS] smsAlerts.js loaded.');
