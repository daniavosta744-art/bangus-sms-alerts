// ========================================
// SMS ALERTS - Node.js / Render.com Version
// Bangus Pond Water Quality Monitor
// ========================================
// ALERT RULES:
//
//   WARNING entered        → SMS immediately, then every 5 mins while still warning
//   CRITICAL entered       → SMS immediately, then every 1 min while still critical
//   WARNING → CRITICAL     → SMS immediately (escalation), then every 1 min
//   CRITICAL → WARNING     → SMS immediately (downgrade), then every 5 mins
//   SAFE reached           → SMS once (recovery), intervals cleared
// ========================================

const admin = require('firebase-admin');
const fetch = require('node-fetch');

// ── CONFIG ───────────────────────────────────────────────────────────────────
const SMS_CONFIG = {
  apiKey:   process.env.TEXTBEE_API_KEY,    // Set in Render.com environment variables
  deviceId: process.env.TEXTBEE_DEVICE_ID,  // Set in Render.com environment variables
  baseUrl:  'https://api.textbee.dev/api/v1',

  // Phone numbers that will receive SMS alerts (Philippine format)
  recipients: [
    process.env.SMS_RECIPIENT_1,            // Set in Render.com environment variables
    // Add more recipients via environment variables if needed
  ].filter(Boolean), // removes undefined entries if not set

  // How often to repeat SMS while the parameter stays in each severity
  repeatIntervalMs: {
    warning:  5 * 60 * 1000,  // 5 minutes
    critical: 1 * 60 * 1000,  // 1 minute
  },

  // Send an SMS when a parameter returns to safe range
  sendRecoverySms: true,

  // Firebase path for SMS send logs (prevents duplicate sends on restart)
  smsLogPath: 'smsAlerts/log',
};
// ─────────────────────────────────────────────────────────────────────────────


// ── FIREBASE ADMIN INIT ───────────────────────────────────────────────────────
// Service account key is stored as an environment variable on Render.com
// We parse it from the FIREBASE_SERVICE_ACCOUNT env variable (JSON string)
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: 'https://prototypefishda-default-rtdb.asia-southeast1.firebasedatabase.app'
  });

  console.log('[SMS] Firebase Admin SDK initialized successfully.');
} catch (error) {
  console.error('[SMS] Failed to initialize Firebase Admin SDK:', error.message);
  console.error('[SMS] Make sure FIREBASE_SERVICE_ACCOUNT environment variable is set correctly.');
  process.exit(1); // Stop the process if Firebase fails to initialize
}

const db = admin.database();
// ─────────────────────────────────────────────────────────────────────────────


// ── STATE ─────────────────────────────────────────────────────────────────────
/*
  _paramState tracks per-parameter alert state:
  {
    [parameter]: {
      severity:    'warning' | 'critical' | null,
      alertId:     string,
      value:       string,
      threshold:   string,
      message:     string,
      intervalId:  number|null,
      lastSentAt:  number,
    }
  }
*/
const _paramState = {};

// Alert IDs already sent SMS for (loaded from Firebase on start, survives restart)
const _sentAlertIds = new Set();
// ─────────────────────────────────────────────────────────────────────────────


// ── INIT ──────────────────────────────────────────────────────────────────────
function initSmsAlerts() {
  console.log('[SMS] Starting SMS alert service...');

  // Load sent log first to avoid re-sending on restart, then watch alerts
  _loadSentLog().then(() => {
    _watchActiveAlerts();
    console.log('[SMS] SMS alert service is running. Watching for alerts...');
  });
}

/**
 * Load previously sent alert IDs from Firebase into memory.
 * Prevents duplicate SMS when the service restarts.
 */
function _loadSentLog() {
  return db
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
  const activeRef = db.ref('alerts/active');

  activeRef.on('child_added', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertAddedOrChanged(alert, false);
  });

  activeRef.on('child_changed', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertAddedOrChanged(alert, true);
  });

  activeRef.on('child_removed', (snapshot) => {
    const alert = { id: snapshot.key, ...snapshot.val() };
    _onAlertRemoved(alert);
  });
}
// ─────────────────────────────────────────────────────────────────────────────


// ── CORE ALERT HANDLER ───────────────────────────────────────────────────────
function _onAlertAddedOrChanged(alert, isUpdate) {
  const { id, parameter, severity, value, threshold, message } = alert;
  const prev = _paramState[parameter];

  const prevSeverity = prev ? prev.severity : null;
  const severityChanged = prevSeverity !== severity;

  // ── Case 1: Service restarted — alert already existed before restart ────
  // Restore state silently and restart the repeat interval without sending SMS.
  if (_sentAlertIds.has(id) && !prev) {
    console.log(`[SMS] Restoring state for "${parameter}" (${severity}) after restart.`);
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

  // ── Case 3: Severity changed or brand new alert ─────────────────────────
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
    intervalId: null, lastSentAt: 0,
  };

  // Send immediately then start repeating
  _sendAlertSms(parameter, reason);
  _startRepeatInterval(parameter);
}

function _onAlertRemoved(alert) {
  const { parameter } = alert;

  // Clear the repeat interval immediately
  _clearRepeatInterval(parameter);
  delete _paramState[parameter];

  if (!SMS_CONFIG.sendRecoverySms) return;

  // Wait 3s to confirm the parameter isn't immediately re-alerting
  setTimeout(() => {
    db.ref('alerts/active')
      .orderByChild('parameter')
      .equalTo(parameter)
      .once('value')
      .then((snap) => {
        if (!snap.exists()) {
          console.log(`[SMS] "${parameter}" returned to safe range. Sending recovery SMS + push.`);
          const smsBody = _buildRecoveryMessage(parameter);
          _sendSms(smsBody);
          _sendFcmRecoveryNotification(parameter);
        } else {
          console.log(`[SMS] "${parameter}" re-alerted immediately — skipping recovery SMS.`);
        }
      });
  }, 3000);
}
// ─────────────────────────────────────────────────────────────────────────────


// ── INTERVAL MANAGEMENT ───────────────────────────────────────────────────────
function _startRepeatInterval(parameter) {
  const state = _paramState[parameter];
  if (!state) return;

  const intervalMs = SMS_CONFIG.repeatIntervalMs[state.severity];
  if (!intervalMs) return;

  console.log(`[SMS] Starting repeat interval for "${parameter}" (${state.severity}): every ${intervalMs / 60000} min.`);

  state.intervalId = setInterval(() => {
    const current = _paramState[parameter];
    if (!current) {
      clearInterval(state.intervalId);
      return;
    }

    // Verify still active in Firebase before sending
    db.ref('alerts/active')
      .orderByChild('parameter')
      .equalTo(parameter)
      .once('value')
      .then((snap) => {
        if (!snap.exists()) {
          _clearRepeatInterval(parameter);
          delete _paramState[parameter];
          return;
        }

        // Confirm severity hasn't changed
        let currentSeverity = null;
        snap.forEach((child) => { currentSeverity = child.val().severity; });

        if (currentSeverity !== current.severity) {
          console.log(`[SMS] Severity changed for "${parameter}" during interval tick — skipping.`);
          return;
        }

        console.log(`[SMS] Repeat interval fired for "${parameter}" (${current.severity}).`);
        _sendAlertSms(parameter, `still ${current.severity}`);
      });
  }, intervalMs);
}

function _clearRepeatInterval(parameter) {
  const state = _paramState[parameter];
  if (state && state.intervalId !== null) {
    clearInterval(state.intervalId);
    state.intervalId = null;
    console.log(`[SMS] Cleared repeat interval for "${parameter}".`);
  }
}
// ─────────────────────────────────────────────────────────────────────────────


// ── FCM PUSH NOTIFICATIONS ───────────────────────────────────────────────────
/**
 * Send a push notification to ALL registered browser tokens.
 * Reads all tokens from Firebase fcmTokens/ and sends to each.
 */
async function _sendFcmNotification(parameter, severity, value, threshold, reason) {
  try {
    const paramLabel = _getParamLabel(parameter);
    const unit       = _getParamUnit(parameter);
    const sevLabel   = severity.toUpperCase();

    // Build notification title and body matching the requested format
    const title = `🔴 ${sevLabel}: Bangus Pond Alert`;
    const body  = [
      `${severity}: ${paramLabel} is on ${severity} level`,
      `Parameter: ${paramLabel}`,
      `Value: ${value} ${unit}`,
    ].join('\n');

    // Load all FCM tokens from Firebase
    const snapshot = await db.ref('fcmTokens').once('value');

    if (!snapshot.exists()) {
      console.log('[FCM] No registered tokens found — skipping push notification.');
      return;
    }

    const messages = [];
    snapshot.forEach((userSnapshot) => {
      userSnapshot.forEach((tokenSnapshot) => {
        const data = tokenSnapshot.val();
        if (data && data.token) {
          messages.push(
            admin.messaging().send({
              token: data.token,
              notification: { title, body },
              webpush: {
                notification: {
                  title,
                  body,
                  icon:  '/images/gataw.png',
                  badge: '/images/gataw.png',
                  tag:   'bangus-pond-alert',
                  renotify: true,
                  requireInteraction: false,
                },
              },
            }).catch((err) => {
              // Token is stale or invalid — remove it from Firebase
              if (
                err.code === 'messaging/registration-token-not-registered' ||
                err.code === 'messaging/invalid-registration-token'
              ) {
                console.log(`[FCM] Removing stale token for uid: ${userSnapshot.key}`);
                tokenSnapshot.ref.remove();
              } else {
                console.error('[FCM] Error sending to token:', err.message);
              }
            })
          );
        }
      });
    });

    await Promise.all(messages);
    console.log(`[FCM] ✅ Push notifications sent to ${messages.length} device(s) for "${parameter}" (${severity}).`);

  } catch (error) {
    console.error('[FCM] Error sending push notifications:', error.message);
  }
}

/**
 * Send a recovery push notification when parameter returns to safe range.
 */
async function _sendFcmRecoveryNotification(parameter) {
  try {
    const paramLabel = _getParamLabel(parameter);
    const title = '✅ Bangus Pond - Resolved';
    const body  = `${paramLabel} has returned to safe range.`;

    const snapshot = await db.ref('fcmTokens').once('value');
    if (!snapshot.exists()) return;

    const messages = [];
    snapshot.forEach((userSnapshot) => {
      userSnapshot.forEach((tokenSnapshot) => {
        const data = tokenSnapshot.val();
        if (data && data.token) {
          messages.push(
            admin.messaging().send({
              token: data.token,
              notification: { title, body },
              webpush: {
                notification: {
                  title, body,
                  icon: '/images/gataw.png',
                  tag:  'bangus-pond-resolved',
                  requireInteraction: false,
                },
              },
            }).catch((err) => {
              if (
                err.code === 'messaging/registration-token-not-registered' ||
                err.code === 'messaging/invalid-registration-token'
              ) {
                tokenSnapshot.ref.remove();
              }
            })
          );
        }
      });
    });

    await Promise.all(messages);
    console.log(`[FCM] ✅ Recovery push notification sent for "${parameter}".`);

  } catch (error) {
    console.error('[FCM] Error sending recovery push notification:', error.message);
  }
}
// ─────────────────────────────────────────────────────────────────────────────


// ── SMS SENDING ───────────────────────────────────────────────────────────────
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

  // Send FCM push notification to all registered browsers
  _sendFcmNotification(parameter, severity, value, threshold, reason);
}

async function _sendSms(message) {
  const { apiKey, deviceId, baseUrl, recipients } = SMS_CONFIG;

  if (!apiKey) {
    console.warn('[SMS] TEXTBEE_API_KEY environment variable not set.');
    return false;
  }
  if (!deviceId) {
    console.warn('[SMS] TEXTBEE_DEVICE_ID environment variable not set.');
    return false;
  }
  if (!recipients || recipients.length === 0) {
    console.warn('[SMS] SMS_RECIPIENT_1 environment variable not set.');
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
      console.log('[SMS] ✅ SMS sent successfully.');
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

  let contextLine = '';
  if (reason && reason.includes('→')) {
    contextLine = `Status changed: ${reason}\n`;
  } else if (reason && reason.startsWith('still')) {
    contextLine = `Still ${severity} — situation ongoing.\n`;
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
function _markAsSent(alertId, parameter, severity) {
  _sentAlertIds.add(alertId);

  db.ref(SMS_CONFIG.smsLogPath)
    .push({ alertId, parameter, severity, sentAt: Date.now() })
    .catch((err) => console.warn('[SMS] Could not write to SMS log:', err));
}
// ─────────────────────────────────────────────────────────────────────────────


// ── KEEP PROCESS ALIVE ────────────────────────────────────────────────────────
// Catch unhandled errors so the service doesn't crash silently
process.on('uncaughtException', (error) => {
  console.error('[SMS] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[SMS] Unhandled promise rejection:', reason);
});

// Log that the service is still alive every hour
setInterval(() => {
  console.log('[SMS] Service is running. Active parameters:', Object.keys(_paramState).length > 0 ? Object.keys(_paramState).join(', ') : 'none');
}, 60 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────


// ── START ─────────────────────────────────────────────────────────────────────
initSmsAlerts();
