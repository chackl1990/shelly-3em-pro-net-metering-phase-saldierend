/*
================================================================================
PROJECT CONTEXT / CHAT SUMMARY
================================================================================

- Device: Shelly Pro 3EM
- Problem:
  - Shelly does NOT perform proper net metering (phase balancing) across phases.
  - Import on one phase and export on others causes BOTH
    `energy` and `energy_returned` to increase.
  - Internal Shelly energy counters are updated only ~once per minute.
  - This behavior is firmware-related and identical in:
      * Web UI
      * RPC
      * MQTT
      * Home Assistant
      * Internal scripts

- Consequence:
  - Shelly energy counters cannot be used for accurate, phase-netted energy.
  - Polling them faster does NOT improve resolution.

- Correct solution:
  - Read total active power (sum of all phases).
  - Integrate power over real elapsed time (dt).
  - Separate import/export by sign.
  - Optionally align the integration to Shelly totals to prevent drift.

- This script:
  - Integrates total active power every second (real dt).
  - Produces net metered import and export energy values.
  - Stores results in persisted virtual number components (Wh).
  - Uses Shelly totals only as a slow reference for correction.
  - Creates a virtual group "Net Metering" containing the result values.

07.11.2026 - chackl1990
supported generation with AI

================================================================================
*/

// =====================================================
// Configuration / User Settings
// =====================================================

// Integration tick interval (ms). Defines resolution for power-to-energy integration.
let INTEGRATION_TICK_MS = 500;

// Polling interval for Shelly internal energy totals (ms).
// Internal counters change slowly, so this can be relatively large.
let TOTALS_TICK_MS = 5000;

// Component IDs for Shelly Pro 3EM
let EM_ID = 0;        // "em" component (power / phase readings)
let EMDATA_ID = 0;    // "emdata" component (internal energy counters)

// Virtual group to show aggregated result components
let NET_METERING_GROUP_ID = 200;
let NET_METERING_GROUP_NAME = "Energy Net Metering";

// Virtual number component IDs for accumulated net import/export (Wh)
let NET_METERED_ENERGY_ID = 200;      // net import energy
let NET_METERED_ENERGY_RET_ID = 201;  // net export energy

let NET_METERED_ENERGY_NAME = "Net Metered Energy";
let NET_METERED_ENERGY_RET_NAME = "Net Metered Energy Return";

// Precomputed component keys for virtual numbers and group
let NET_METERED_ENERGY_KEY = "number:" + NET_METERED_ENERGY_ID;
let NET_METERED_ENERGY_RET_KEY = "number:" + NET_METERED_ENERGY_RET_ID;
let NET_METERING_GROUP_KEY = "group:" + NET_METERING_GROUP_ID;

// Debug logging flag
let LOG = false;


// =====================================================
// Runtime State
// =====================================================

// Handles for virtual number components used to persist accumulated energy
let net_metered_energy_handle = null;
let net_metered_energy_ret_handle = null;

// Accumulated net import/export energy (Wh), persisted via virtual numbers
let net_metered_energy_wh = 0.0;       // accumulated net import energy
let net_metered_energy_ret_wh = 0.0;   // accumulated net export energy

// Integrated energy within the current correction window (Wh)
let delta_energy_integrate_wh = 0.0;        // integrated import in current window
let delta_energy_ret_integrate_wh = 0.0;    // integrated export in current window

// Minimum energy difference used to decide if a correction is meaningful
const ENERGY_EPSILON_WH = 0.001;

// Baseline values of Shelly’s internal energy counters at the start of a window
let baseline_total_energy_wh = null;        // emdata.total_act at window start
let baseline_total_energy_ret_wh = null;    // emdata.total_act_ret at window start

// Most recently observed Shelly totals, used for change detection
let last_seen_total_energy_wh = null;
let last_seen_total_energy_ret_wh = null;

// State for change/stability detection of Shelly totals
let totals_changed_since_last_correction = false;
let totals_last_change_uptime_ms = 0;
let last_correction_uptime_ms = 0;

// Timestamp of last power integration tick (uptime in ms)
let last_integration_uptime_ms = null;

// Current Shelly internal energy totals (Wh), updated by readTotalsWh()
let current_total_energy_wh = null;
let current_total_energy_ret_wh = null;


// =====================================================
// Helper Functions
// =====================================================

/**
 * Conditional logger that prints only if LOG is enabled.
 */
function log() {
    if (!LOG) return;
    print.apply(null, arguments);
}

/**
 * Returns true if x is a finite numeric value.
 */
function isNumber(x) {
    return typeof x === "number" && isFinite(x);
}

/**
 * Clamps a numeric value to the inclusive range [minValue, maxValue].
 */
function clampMinMax(value, minValue, maxValue) {
    if (value < minValue) return minValue;
    if (value > maxValue) return maxValue;
    return value;
}

/**
 * Returns the device uptime in milliseconds.
 */
function getUptimeMs() {
    return Shelly.getUptimeMs();
}

/**
 * Finds and returns a component by key from a Shelly.GetComponents result list.
 */
function getComponentByKeyFromList(components, key) {
    for (let i = 0; i < components.length; i++) {
        if (components[i].key === key) return components[i];
    }
    return null;
}


// =====================================================
// Virtual Component Management
// =====================================================

/**
 * Ensures that a persisted virtual number component with a given id and key
 * exists and has the expected name. Calls cb(true/false) on completion.
 */
function ensureVirtualNumberComponent(id, key, expectedName, cb) {
    Shelly.call(
        "Shelly.GetComponents",
        { dynamic_only: true, include: ["config"] },
        function (res) {
            let components = res && res.components ? res.components : [];
            let existing = getComponentByKeyFromList(components, key);

            function createNew() {
                Shelly.call(
                    "Virtual.Add",
                    {
                        type: "number",
                        id: id,
                        config: {
                            name: expectedName,
                            persisted: true,
                            meta: {
                                ui: {
                                    view: "label",
                                    unit: "Wh",
                                    step: 1
                                }
                            }
                        }
                    },
                    function (_res, err) {
                        if (err) {
                            log("Virtual.Add failed for", key, "error:", JSON.stringify(err));
                            cb(false);
                            return;
                        }
                        log("Virtual number created:", key, "name:", expectedName);
                        cb(true);
                    }
                );
            }

            if (!existing) {
                log("Virtual number", key, "not found, creating new");
                createNew();
                return;
            }

            let name = existing.config ? existing.config.name : null;
            if (name !== expectedName) {
                log("Virtual number", key, "exists but name differs:", name, "-> recreating");
                Shelly.call("Virtual.Delete", { key: key }, function () {
                    createNew();
                });
                return;
            }

            log("Virtual number", key, "already exists with correct name:", name);
            cb(true);
        }
    );
}

/**
 * Ensures that a virtual group component with a given id and key exists,
 * has the expected name, and contains the specified member keys.
 * Calls cb(true/false) on completion.
 */
function ensureVirtualGroupComponent(id, key, expectedName, members, cb) {
    Shelly.call(
        "Shelly.GetComponents",
        { dynamic_only: true, include: ["config"] },
        function (res) {
            let components = res && res.components ? res.components : [];
            let existing = getComponentByKeyFromList(components, key);

            function configure() {
                Shelly.call(
                    "Group.SetConfig",
                    { id: id, config: { name: expectedName } },
                    function () {
                        Shelly.call("Group.Set", { id: id, value: members }, function () {
                            log("Group configured:", key, "name:", expectedName, "members:", JSON.stringify(members));
                            cb(true);
                        });
                    }
                );
            }

            function createNew() {
                Shelly.call(
                    "Virtual.Add",
                    { type: "group", id: id, config: { name: expectedName } },
                    function () {
                        log("Group created:", key, "name:", expectedName);
                        configure();
                    }
                );
            }

            let name = existing && existing.config ? existing.config.name : null;
            if (!existing) {
                log("Group", key, "not found, creating new");
                createNew();
                return;
            }

            if (name !== expectedName) {
                log("Group", key, "exists but name differs:", name, "-> recreating");
                Shelly.call("Virtual.Delete", { key: key }, function () {
                    createNew();
                });
                return;
            }

            log("Group", key, "already exists with correct name:", name);
            configure();
        }
    );
}


// =====================================================
// Shelly Readings
// =====================================================

/**
 * Reads total active power (sum of all phases) in Watts from the EM component.
 * Returns a numeric value or null if unavailable.
 */
function readTotalPowerW() {
    let em = Shelly.getComponentStatus("em", EM_ID);
    if (!em || !isNumber(em.total_act_power)) return null;
    return em.total_act_power;
}

/**
 * Reads Shelly internal energy counters (Wh) from the EMDATA component and
 * stores them in current_total_energy_wh and current_total_energy_ret_wh.
 * Returns true on success, false on failure.
 */
function readTotalsWh() {
    let st = Shelly.getComponentStatus("emdata", EMDATA_ID);
    if (!st) return false;
    if (!isNumber(st.total_act) || !isNumber(st.total_act_ret)) return false;
    current_total_energy_wh = st.total_act;
    current_total_energy_ret_wh = st.total_act_ret;
    return true;
}


// =====================================================
// Integration & Correction Logic
// =====================================================

/**
 * Integrates total active power over elapsed time to produce energy in Wh.
 * Uses device uptime to compute dt between integration ticks.
 */
function integratePower() {
    let now = getUptimeMs();

    if (last_integration_uptime_ms === null) {
        last_integration_uptime_ms = now;
        return;
    }

    let dt_ms = now - last_integration_uptime_ms;
    if (dt_ms <= 0) return;

    last_integration_uptime_ms = now;

    let p = readTotalPowerW();
    if (!isNumber(p)) return;

    let wh = p * (dt_ms / 3600000.0);
    if (wh >= 0) {
        delta_energy_integrate_wh += wh;
    } else {
        delta_energy_ret_integrate_wh += -wh;
    }
}

/**
 * Initializes baseline Shelly total energy counters at the beginning of a
 * correction window, if not already set.
 */
function startBaselineIfNeeded(t, r) {
    if (!isNumber(baseline_total_energy_wh) || !isNumber(baseline_total_energy_ret_wh)) {
        baseline_total_energy_wh = t;
        baseline_total_energy_ret_wh = r;

        last_seen_total_energy_wh = t;
        last_seen_total_energy_ret_wh = r;

        totals_changed_since_last_correction = false;
        totals_last_change_uptime_ms = getUptimeMs();
        last_correction_uptime_ms = getUptimeMs();

        delta_energy_integrate_wh = 0.0;
        delta_energy_ret_integrate_wh = 0.0;

        log(
            "Baseline initialized:",
            "baseline_total_energy_wh =", baseline_total_energy_wh,
            "baseline_total_energy_ret_wh =", baseline_total_energy_ret_wh
        );
    }
}

/**
 * Tracks changes in Shelly internal totals to detect when a new stable value
 * is available for correction.
 */
function updateTotalsChangeDetection(t, r) {
    if (!isNumber(last_seen_total_energy_wh) || !isNumber(last_seen_total_energy_ret_wh)) {
        last_seen_total_energy_wh = t;
        last_seen_total_energy_ret_wh = r;
        return;
    }

    if (t !== last_seen_total_energy_wh || r !== last_seen_total_energy_ret_wh) {
        totals_changed_since_last_correction = true;
        totals_last_change_uptime_ms = getUptimeMs();
        last_seen_total_energy_wh = t;
        last_seen_total_energy_ret_wh = r;

        log(
            "Totals changed:",
            "total_energy_wh:", t,
            "total_energy_ret_wh:", r
        );
    }
}

/**
 * Applies a correction to the integrated import/export energy based on the
 * difference between Shelly internal totals and the baseline, once the totals
 * have been stable for a minimum time.
 */
function applyCorrectionIfReady(t, r) {
    if (!totals_changed_since_last_correction) return;

    let now = getUptimeMs();
    if ((now - totals_last_change_uptime_ms) < 5000) return;

    let dt_total = t - baseline_total_energy_wh;
    let dt_ret_total = r - baseline_total_energy_ret_wh;

    let sum_total = dt_total - dt_ret_total;
    let sum_integrated = delta_energy_integrate_wh - delta_energy_ret_integrate_wh;

    let k = 1.0;
    if (isNumber(sum_integrated) && Math.abs(sum_integrated) > ENERGY_EPSILON_WH) {
        k = sum_total / sum_integrated;
        if (!isNumber(k)) k = 1.0;
        if (k <= 0.001) k = 1.0;
    }

    k = clampMinMax(k, 0.1, 10.0);

    let dt_int = delta_energy_integrate_wh * k;
    let dt_ret_int = delta_energy_ret_integrate_wh * k;

    net_metered_energy_wh += dt_int;
    net_metered_energy_ret_wh += dt_ret_int;

    if (net_metered_energy_handle) net_metered_energy_handle.setValue(net_metered_energy_wh);
    if (net_metered_energy_ret_handle) net_metered_energy_ret_handle.setValue(net_metered_energy_ret_wh);

    log(
        "Correction applied:",
        "correction_factor =", k,
        "delta_total_energy_wh =", dt_total,
        "delta_total_energy_ret_wh =", dt_ret_total,
        "sum_total =", sum_total,
        "sum_integrated =", sum_integrated,
        "delta_energy_integrate_corrected =", dt_int,
        "delta_energy_ret_integrate_corrected =", dt_ret_int,
        "net_metered_energy_wh (new) =", net_metered_energy_wh,
        "net_metered_energy_ret_wh (new) =", net_metered_energy_ret_wh
    );

    baseline_total_energy_wh = t;
    baseline_total_energy_ret_wh = r;

    delta_energy_integrate_wh = 0.0;
    delta_energy_ret_integrate_wh = 0.0;

    totals_changed_since_last_correction = false;
    last_correction_uptime_ms = now;

    last_integration_uptime_ms = now;
}


// =====================================================
// Timer Tick Functions
// =====================================================

/**
 * Timer callback for fast integration ticks. Performs only power integration.
 */
function integrationTick() {
    integratePower();
}

/**
 * Timer callback for slower totals ticks. Reads Shelly totals and triggers
 * baseline initialization, change detection, and correction.
 */
function totalsTick() {
    if (!readTotalsWh()) return;
    startBaselineIfNeeded(current_total_energy_wh, current_total_energy_ret_wh);
    updateTotalsChangeDetection(current_total_energy_wh, current_total_energy_ret_wh);
    applyCorrectionIfReady(current_total_energy_wh, current_total_energy_ret_wh);
}


// =====================================================
// Startup & Initialization
// =====================================================

/**
 * Loads persisted accumulated net import/export energy from virtual numbers
 * into local state variables.
 */
function loadPersisted() {
    net_metered_energy_handle = Virtual.getHandle(NET_METERED_ENERGY_KEY);
    net_metered_energy_ret_handle = Virtual.getHandle(NET_METERED_ENERGY_RET_KEY);

    let s1 = net_metered_energy_handle ? net_metered_energy_handle.getStatus() : null;
    let s2 = net_metered_energy_ret_handle ? net_metered_energy_ret_handle.getStatus() : null;

    net_metered_energy_wh = (s1 && isNumber(s1.value)) ? s1.value : 0.0;
    net_metered_energy_ret_wh = (s2 && isNumber(s2.value)) ? s2.value : 0.0;

    log(
        "Startup values loaded:",
        "net_metered_energy_wh =", net_metered_energy_wh,
        "net_metered_energy_ret_wh =", net_metered_energy_ret_wh
    );
}

/**
 * Entry point: ensures virtual components exist, loads persisted state,
 * initializes baseline totals (if available), and starts the timers.
 */
function start() {
    ensureVirtualNumberComponent(
        NET_METERED_ENERGY_ID,
        NET_METERED_ENERGY_KEY,
        NET_METERED_ENERGY_NAME,
        function () {
            ensureVirtualNumberComponent(
                NET_METERED_ENERGY_RET_ID,
                NET_METERED_ENERGY_RET_KEY,
                NET_METERED_ENERGY_RET_NAME,
                function () {
                    ensureVirtualGroupComponent(
                        NET_METERING_GROUP_ID,
                        NET_METERING_GROUP_KEY,
                        NET_METERING_GROUP_NAME,
                        [
                            NET_METERED_ENERGY_KEY,
                            NET_METERED_ENERGY_RET_KEY
                        ],
                        function () {
                            loadPersisted();

                            if (readTotalsWh()) {
                                startBaselineIfNeeded(
                                    current_total_energy_wh,
                                    current_total_energy_ret_wh
                                );
                            }

                            Timer.set(INTEGRATION_TICK_MS, true, integrationTick);
                            Timer.set(TOTALS_TICK_MS, true, totalsTick);

                            log("Net metering script started");
                        }
                    );
                }
            );
        }
    );
}

start();
