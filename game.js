(function () {
  var defs = {}, cache = {};
  function norm(base, dep) {
    if (dep.charAt(0) !== '.') return dep;
    var parts = base.split('/'); parts.pop();
    dep.split('/').forEach(function (p) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); });
    return parts.join('/');
  }
  function load(name) {
    if (cache[name]) return cache[name];
    var d = defs[name];
    if (!d) throw new Error('Missing module: ' + name);
    var exp = {}; cache[name] = exp;
    var args = d.deps.map(function (dep) { return dep === 'require' ? null : dep === 'exports' ? exp : load(norm(name, dep)); });
    d.fn.apply(null, args);
    return exp;
  }
  window.define = function (name, deps, fn) { defs[name] = { deps: deps, fn: fn }; };
  window.__bootGame = function (name) { load(name); };
})();
// Shared contracts for the combat simulation: input frames, attack/character data, runtime events.
// Everything in src/combat is renderer-free so it can run headless (tests, AI vs AI, replays later).
define("combat/types", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.emptyInput = exports.emptyActions = exports.ACTIONS = void 0;
    exports.ACTIONS = ['light', 'heavy', 'special', 'beam', 'guard', 'jump', 'dodge', 'grab', 'alt', 'ultimate', 'pause'];
    const emptyActions = () => ({
        light: false, heavy: false, special: false, beam: false, guard: false,
        jump: false, dodge: false, grab: false, alt: false, ultimate: false, pause: false,
    });
    exports.emptyActions = emptyActions;
    const emptyInput = () => ({ moveX: 0, moveY: 0, held: (0, exports.emptyActions)(), pressed: (0, exports.emptyActions)() });
    exports.emptyInput = emptyInput;
});
define("characters/TransformationSystem", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.REVERT_COOLDOWN = exports.REVERT_WINDUP = exports.TRANSFORM_WINDUP = void 0;
    exports.buildFormDef = buildFormDef;
    exports.windupOf = windupOf;
    exports.nextFormIndex = nextFormIndex;
    exports.canTransform = canTransform;
    /** Default seconds the fighter is locked (and hittable) while changing into a form (forms may override). */
    exports.TRANSFORM_WINDUP = 1.1;
    /** Reverting to the base form is quicker but still not free of risk. */
    exports.REVERT_WINDUP = 0.3;
    /** Cooldown applied after reverting to the base form. */
    exports.REVERT_COOLDOWN = 2;
    /**
     * Effective definition of `base` while wearing `form` (null = base form).
     * Pure: never mutates its inputs. Only the multipliers listed in `FormDef.statMul` can change, so a form can
     * never touch max HP or max energy - transforming cannot heal or refill resources.
     */
    function buildFormDef(base, form) {
        if (!form)
            return base;
        const stats = { ...base.stats };
        const mul = form.statMul ?? {};
        for (const key of Object.keys(mul)) {
            const m = mul[key];
            if (m !== undefined)
                stats[key] = stats[key] * m;
        }
        return {
            ...base,
            stats,
            moves: { ...base.moves, ...form.moves },
            rig: {
                ...base.rig,
                colors: { ...base.rig.colors, ...form.colors },
                extras: form.extras ?? base.rig.extras,
            },
        };
    }
    /** Seconds of the transformation sequence for entering `form` (null = reverting to base). */
    function windupOf(form) {
        return form ? (form.windup ?? exports.TRANSFORM_WINDUP) : exports.REVERT_WINDUP;
    }
    /** Index of the form entered by the next transform press: base -> form 0 -> form 1 -> ... -> base (-1). */
    function nextFormIndex(base, current) {
        const n = base.forms?.length ?? 0;
        if (n === 0)
            return -1;
        return current + 1 >= n ? -1 : current + 1;
    }
    /** True when the transform button would currently do something. */
    function canTransform(f) {
        const forms = f.baseDef.forms;
        if (!forms || forms.length === 0)
            return false;
        if (f.formCooldown > 0 || !f.grounded)
            return false;
        const target = nextFormIndex(f.baseDef, f.formIndex);
        if (target < 0)
            return true; // reverting costs nothing
        return f.energy >= forms[target].energyCost;
    }
});
define("combat/Fighter", ["require", "exports", "characters/TransformationSystem"], function (require, exports, TransformationSystem_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Fighter = void 0;
    /** Runtime state of one combatant. Plain data + tiny helpers; behaviour lives in FighterController / Battle. */
    class Fighter {
        index;
        /** Unmodified definition. */
        baseDef;
        /** EFFECTIVE definition: baseDef with the active form applied. Everything else reads this. */
        def;
        stats;
        // Transform (world: x/z ground plane, y up). `yaw`: forward = (sin yaw, cos yaw).
        x = 0;
        y = 0;
        z = 0;
        vx = 0;
        vy = 0;
        vz = 0;
        yaw = 0;
        // Previous tick (render interpolation).
        px = 0;
        py = 0;
        pz = 0;
        pyaw = 0;
        hp;
        energy;
        guard;
        state = 'idle';
        /** Seconds since entering `state`. */
        stateTime = 0;
        /** Remaining duration for timed states (hitstun, down, ...). */
        stateTimer = 0;
        /** Generic action lock (landing lag, dodge recovery). Neutral actions need lock <= 0. */
        lock = 0;
        attack = null;
        attackTime = 0;
        attackConnected = false;
        /** Index of last sub-hit that already resolved (multi-hit attacks). */
        subHit = -1;
        firedProjectile = false;
        comboStep = 0;
        /** Time left before an unfinished light-attack chain resets. */
        comboReset = 0;
        /** True while holding the energy-channel button (state 'charge' without a beam). */
        channeling = false;
        chargeTime = 0;
        beamCooldown = 0;
        airAttackUsed = false;
        invuln = 0;
        guardAge = 0;
        guardLock = 0;
        guardRegenDelay = 0;
        dodgeCooldown = 0;
        specialCooldown = 0;
        buffer = null;
        /** Hits this fighter has taken in the current combo (HUD + damage scaling). */
        hitsTaken = 0;
        comboDamage = 0;
        comboTimer = 0;
        lastAttacker = -1;
        grabPartner = -1;
        techWindow = 0;
        flash = 0;
        powerMul = 1;
        speedMul = 1;
        /** Energy timer (heroes with a power timer). */
        timerLeft = 0;
        timerExpired = false;
        enraged = false;
        /** Beam-clash button mash meter (decays). */
        mash = 0;
        // Animation helpers
        localVx = 0; // velocity along facing (+forward)
        localVz = 0; // velocity sideways (+left)
        walkSpeedFrac = 0;
        // Stats tracking (records / ranks)
        damageDealt = 0;
        damageTaken = 0;
        hitsLanded = 0;
        maxCombo = 0;
        blocks = 0;
        counters = 0;
        constructor(index, def) {
            this.index = index;
            this.baseDef = def;
            this.def = def;
            this.stats = def.stats;
            this.hp = def.stats.maxHp;
            this.energy = def.stats.maxEnergy * 0.4;
            this.guard = def.stats.maxGuard;
            this.timerLeft = def.timer?.seconds ?? 0;
        }
        /** The ultimate currently being performed (null otherwise). */
        ultimate = null;
        ultFired = false;
        /** True once the meter has announced "ready" (re-armed when the ultimate becomes unavailable). */
        ultReady = false;
        ultimateCooldown = 0;
        /** Hits taken while launched in the current air combo. */
        juggle = 0;
        perfectDodged = false;
        /** -1 = base form, otherwise index into baseDef.forms. */
        formIndex = -1;
        /** Seconds left in a timed form (0 when not applicable). */
        formTimer = 0;
        formCooldown = 0;
        /** Form chosen by an in-progress transformation. */
        pendingForm = -1;
        get form() {
            return this.formIndex >= 0 ? (this.baseDef.forms?.[this.formIndex] ?? null) : null;
        }
        get formName() {
            return this.form?.name ?? '';
        }
        /** Swap the effective definition. Never changes hp or energy (only clamps guard to the new maximum). */
        applyForm(index) {
            const forms = this.baseDef.forms;
            this.formIndex = forms && index >= 0 && index < forms.length ? index : -1;
            const form = this.form;
            this.def = (0, TransformationSystem_js_1.buildFormDef)(this.baseDef, form);
            this.stats = this.def.stats;
            this.guard = Math.min(this.guard, this.stats.maxGuard);
            this.formTimer = form?.duration ?? 0;
        }
        get alive() {
            return this.hp > 0 && this.state !== 'defeated';
        }
        get radius() {
            return this.stats.radius;
        }
        get height() {
            return this.stats.height;
        }
        get grounded() {
            return this.y <= 0.001;
        }
        get forwardX() {
            return Math.sin(this.yaw);
        }
        get forwardZ() {
            return Math.cos(this.yaw);
        }
        /** True when the fighter may start a new action (not stunned, attacking, etc). */
        get neutral() {
            return (this.state === 'idle' || this.state === 'walk' || this.state === 'guard') && this.lock <= 0;
        }
        /** Cannot be hit by anything (dodge frames, wake-up, being on the ground, mid-throw animation). */
        get untouchable() {
            return (this.invuln > 0 ||
                this.state === 'launched' ||
                this.state === 'down' ||
                this.state === 'getup' ||
                this.state === 'defeated' ||
                this.state === 'grabbed');
        }
        setState(state, duration = 0) {
            this.state = state;
            this.stateTime = 0;
            this.stateTimer = duration;
        }
        /** Strength of the move currently being performed (0 when not attacking). Used by AI. */
        get attackPhase() {
            const a = this.attack;
            if (this.state !== 'attack' || !a)
                return 'none';
            if (this.attackTime < a.startup)
                return 'startup';
            if (this.attackTime < a.startup + a.active)
                return 'active';
            return 'recovery';
        }
        resetForRound(energyFrac = 0.4) {
            this.applyForm(-1);
            this.ultimate = null;
            this.ultFired = false;
            this.ultReady = false;
            this.ultimateCooldown = 0;
            this.juggle = 0;
            this.perfectDodged = false;
            this.formCooldown = 0;
            this.pendingForm = -1;
            this.hp = this.stats.maxHp;
            this.energy = this.stats.maxEnergy * energyFrac;
            this.guard = this.stats.maxGuard;
            this.state = 'idle';
            this.stateTime = 0;
            this.stateTimer = 0;
            this.lock = 0;
            this.attack = null;
            this.attackTime = 0;
            this.attackConnected = false;
            this.subHit = -1;
            this.firedProjectile = false;
            this.comboStep = 0;
            this.comboReset = 0;
            this.channeling = false;
            this.chargeTime = 0;
            this.beamCooldown = 0;
            this.airAttackUsed = false;
            this.invuln = 0;
            this.guardAge = 0;
            this.guardLock = 0;
            this.guardRegenDelay = 0;
            this.dodgeCooldown = 0;
            this.specialCooldown = 0;
            this.buffer = null;
            this.hitsTaken = 0;
            this.comboDamage = 0;
            this.comboTimer = 0;
            this.lastAttacker = -1;
            this.grabPartner = -1;
            this.techWindow = 0;
            this.flash = 0;
            this.powerMul = 1;
            this.speedMul = 1;
            this.timerLeft = this.def.timer?.seconds ?? 0;
            this.timerExpired = false;
            this.enraged = false;
            this.mash = 0;
            this.vx = this.vy = this.vz = 0;
            this.y = 0;
        }
    }
    exports.Fighter = Fighter;
});
define("combat/world", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
});
// Pure damage / reaction formulas. No state, no randomness -> trivially unit-testable.
define("combat/DamageSystem", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.REFERENCE_MASS = exports.CHIP_FRACTION = exports.COMBO_SCALE_MIN = exports.COMBO_SCALE_STEP = void 0;
    exports.comboScale = comboScale;
    exports.defenseMultiplier = defenseMultiplier;
    exports.computeDamage = computeDamage;
    exports.chipDamage = chipDamage;
    exports.knockbackSpeed = knockbackSpeed;
    exports.scaledHitstun = scaledHitstun;
    exports.energyOnTakingDamage = energyOnTakingDamage;
    exports.applyGuardDamage = applyGuardDamage;
    exports.COMBO_SCALE_STEP = 0.1;
    exports.COMBO_SCALE_MIN = 0.3;
    exports.CHIP_FRACTION = 0.06;
    exports.REFERENCE_MASS = 100;
    /** Damage multiplier for a hit that lands after `prevHits` hits in the same combo. */
    function comboScale(prevHits) {
        return Math.max(exports.COMBO_SCALE_MIN, 1 - exports.COMBO_SCALE_STEP * Math.max(0, prevHits));
    }
    /** Defense rating (0..100+) -> damage multiplier (<= 1). */
    function defenseMultiplier(defense) {
        return 100 / (100 + Math.max(0, defense) * 1.2);
    }
    /** Final damage of a connecting hit. Always at least 1. */
    function computeDamage(base, attackerPower, defense, prevHits) {
        return Math.max(1, Math.round(base * attackerPower * defenseMultiplier(defense) * comboScale(prevHits)));
    }
    /** Damage taken through a block. Never lethal on its own (caller clamps hp). */
    function chipDamage(base) {
        return Math.max(1, Math.round(base * exports.CHIP_FRACTION));
    }
    /** Horizontal speed given to a target. Heavier fighters are pushed less (sqrt falloff keeps giants movable). */
    function knockbackSpeed(knockback, targetMass) {
        return knockback * Math.sqrt(exports.REFERENCE_MASS / Math.max(1, targetMass));
    }
    /** Hit stun shrinks as a combo gets longer, so long strings are escapable. */
    function scaledHitstun(base, prevHits) {
        return base * Math.max(0.55, 1 - 0.05 * Math.max(0, prevHits));
    }
    /** Energy gained by the defender for being hit (a comeback mechanic). */
    function energyOnTakingDamage(damage) {
        return damage * 0.08;
    }
    function applyGuardDamage(guard, guardDamage) {
        const g = guard - guardDamage;
        return g <= 0 ? { guard: 0, broken: true } : { guard: g, broken: false };
    }
});
define("combat/HitDetection", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.distance = distance;
    exports.gap = gap;
    exports.bearing = bearing;
    exports.meleeConnects = meleeConnects;
    exports.facingAttacker = facingAttacker;
    exports.segmentCircle = segmentCircle;
    const DEG = Math.PI / 180;
    /** Horizontal distance between fighter centres. */
    function distance(a, b) {
        return Math.hypot(b.x - a.x, b.z - a.z);
    }
    /** Surface-to-surface gap (negative when overlapping). */
    function gap(a, b) {
        return distance(a, b) - a.radius - b.radius;
    }
    /** Bearing (yaw) from `a` toward `b`, using the forward = (sin, cos) convention. */
    function bearing(a, b) {
        return Math.atan2(b.x - a.x, b.z - a.z);
    }
    /** Cone + range + vertical-band test for a melee attack. Real geometry, not "animation played = damage". */
    function meleeConnects(att, tgt, a) {
        const dx = tgt.x - att.x;
        const dz = tgt.z - att.z;
        const dist = Math.hypot(dx, dz);
        if (dist - tgt.radius > a.reach)
            return false;
        if (dist > 1e-4) {
            const dot = (att.forwardX * dx + att.forwardZ * dz) / dist;
            const ang = Math.acos(Math.max(-1, Math.min(1, dot)));
            // Widen the cone by the angular size of the target so wide fighters are not missed at point-blank.
            const slack = Math.atan2(tgt.radius, Math.max(dist, 0.01));
            if (ang - slack > (a.arc * DEG) / 2)
                return false;
        }
        const low = att.y + a.yLow * att.height;
        const high = att.y + a.yHigh * att.height;
        if (tgt.y + tgt.height < low || tgt.y > high)
            return false;
        return true;
    }
    /** True when `defender` faces `attackerX/Z` closely enough to block (guard cone). */
    function facingAttacker(defender, ax, az, halfConeDeg = 75) {
        const dx = ax - defender.x;
        const dz = az - defender.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 1e-4)
            return true;
        const dot = (defender.forwardX * dx + defender.forwardZ * dz) / dist;
        return Math.acos(Math.max(-1, Math.min(1, dot))) <= halfConeDeg * DEG;
    }
    /** Closest approach of a circle (centre cx,cz radius r) to a ground-plane segment. */
    function segmentCircle(sx, sz, dirX, dirZ, length, cx, cz, radius) {
        const rx = cx - sx;
        const rz = cz - sz;
        const along = Math.max(0, Math.min(length, rx * dirX + rz * dirZ));
        const px = sx + dirX * along;
        const pz = sz + dirZ * along;
        const lateral = Math.hypot(cx - px, cz - pz);
        return { hit: lateral <= radius, along, lateral };
    }
});
// Small math toolkit: scalar helpers, seeded RNG, column-major 4x4 matrices (WebGL layout).
define("math", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.MatStack = exports.mat4 = exports.Rng = exports.turnToward = exports.angleDiff = exports.wrapAngle = exports.approach = exports.damp = exports.easeInOut = exports.easeOutCubic = exports.smoothstep = exports.saturate = exports.lerp = exports.clamp = exports.TAU = void 0;
    exports.m4Identity = m4Identity;
    exports.m4Copy = m4Copy;
    exports.m4Perspective = m4Perspective;
    exports.m4LookAt = m4LookAt;
    exports.m4Mul = m4Mul;
    exports.m4Translate = m4Translate;
    exports.m4RotY = m4RotY;
    exports.m4RotX = m4RotX;
    exports.m4RotZ = m4RotZ;
    exports.m4Scale = m4Scale;
    exports.m4NormalMat3 = m4NormalMat3;
    exports.TAU = Math.PI * 2;
    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    exports.clamp = clamp;
    const lerp = (a, b, t) => a + (b - a) * t;
    exports.lerp = lerp;
    const saturate = (v) => (0, exports.clamp)(v, 0, 1);
    exports.saturate = saturate;
    const smoothstep = (a, b, v) => {
        const t = (0, exports.saturate)((v - a) / (b - a));
        return t * t * (3 - 2 * t);
    };
    exports.smoothstep = smoothstep;
    const easeOutCubic = (t) => 1 - Math.pow(1 - (0, exports.saturate)(t), 3);
    exports.easeOutCubic = easeOutCubic;
    const easeInOut = (t) => {
        const x = (0, exports.saturate)(t);
        return x * x * (3 - 2 * x);
    };
    exports.easeInOut = easeInOut;
    /** Frame-rate independent exponential smoothing toward a target. */
    const damp = (current, target, rate, dt) => (0, exports.lerp)(current, target, 1 - Math.exp(-rate * dt));
    exports.damp = damp;
    /** Move `current` toward `target` by at most `maxDelta`. */
    const approach = (current, target, maxDelta) => {
        if (current < target)
            return Math.min(current + maxDelta, target);
        return Math.max(current - maxDelta, target);
    };
    exports.approach = approach;
    const wrapAngle = (a) => {
        let x = a % exports.TAU;
        if (x > Math.PI)
            x -= exports.TAU;
        else if (x < -Math.PI)
            x += exports.TAU;
        return x;
    };
    exports.wrapAngle = wrapAngle;
    /** Shortest signed angular difference b - a. */
    const angleDiff = (a, b) => (0, exports.wrapAngle)(b - a);
    exports.angleDiff = angleDiff;
    /** Rotate `current` toward `target` by at most `maxStep` radians. */
    const turnToward = (current, target, maxStep) => {
        const d = (0, exports.angleDiff)(current, target);
        if (Math.abs(d) <= maxStep)
            return target;
        return (0, exports.wrapAngle)(current + Math.sign(d) * maxStep);
    };
    exports.turnToward = turnToward;
    /** Deterministic PRNG (mulberry32). Used by simulation + AI so combat is reproducible from a seed. */
    class Rng {
        s;
        constructor(seed = 1) {
            this.s = seed >>> 0;
        }
        next() {
            this.s = (this.s + 0x6d2b79f5) >>> 0;
            let t = this.s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        }
        range(lo, hi) {
            return lo + (hi - lo) * this.next();
        }
        chance(p) {
            return this.next() < p;
        }
        pick(arr) {
            return arr[Math.floor(this.next() * arr.length) % arr.length];
        }
    }
    exports.Rng = Rng;
    const mat4 = () => {
        const m = new Float32Array(16);
        m[0] = m[5] = m[10] = m[15] = 1;
        return m;
    };
    exports.mat4 = mat4;
    function m4Identity(m) {
        m.fill(0);
        m[0] = m[5] = m[10] = m[15] = 1;
        return m;
    }
    function m4Copy(out, a) {
        out.set(a);
        return out;
    }
    function m4Perspective(out, fovy, aspect, near, far) {
        const f = 1 / Math.tan(fovy / 2);
        out.fill(0);
        out[0] = f / aspect;
        out[5] = f;
        out[10] = (far + near) / (near - far);
        out[11] = -1;
        out[14] = (2 * far * near) / (near - far);
        return out;
    }
    function m4LookAt(out, ex, ey, ez, tx, ty, tz, ux = 0, uy = 1, uz = 0) {
        let zx = ex - tx, zy = ey - ty, zz = ez - tz;
        let len = Math.hypot(zx, zy, zz) || 1;
        zx /= len;
        zy /= len;
        zz /= len;
        let xx = uy * zz - uz * zy, xy = uz * zx - ux * zz, xz = ux * zy - uy * zx;
        len = Math.hypot(xx, xy, xz) || 1;
        xx /= len;
        xy /= len;
        xz /= len;
        const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
        out[0] = xx;
        out[1] = yx;
        out[2] = zx;
        out[3] = 0;
        out[4] = xy;
        out[5] = yy;
        out[6] = zy;
        out[7] = 0;
        out[8] = xz;
        out[9] = yz;
        out[10] = zz;
        out[11] = 0;
        out[12] = -(xx * ex + xy * ey + xz * ez);
        out[13] = -(yx * ex + yy * ey + yz * ez);
        out[14] = -(zx * ex + zy * ey + zz * ez);
        out[15] = 1;
        return out;
    }
    /** out = a * b (column-major). `out` may alias neither input. */
    function m4Mul(out, a, b) {
        for (let c = 0; c < 4; c++) {
            const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
            out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
            out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
            out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
            out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
        }
        return out;
    }
    // In-place post-multiplied transforms (m = m * T).
    function m4Translate(m, x, y, z) {
        m[12] = m[0] * x + m[4] * y + m[8] * z + m[12];
        m[13] = m[1] * x + m[5] * y + m[9] * z + m[13];
        m[14] = m[2] * x + m[6] * y + m[10] * z + m[14];
        m[15] = m[3] * x + m[7] * y + m[11] * z + m[15];
        return m;
    }
    function m4RotY(m, a) {
        const c = Math.cos(a), s = Math.sin(a);
        for (let i = 0; i < 4; i++) {
            const p = m[i], q = m[8 + i];
            m[i] = p * c - q * s;
            m[8 + i] = p * s + q * c;
        }
        return m;
    }
    function m4RotX(m, a) {
        const c = Math.cos(a), s = Math.sin(a);
        for (let i = 0; i < 4; i++) {
            const p = m[4 + i], q = m[8 + i];
            m[4 + i] = p * c + q * s;
            m[8 + i] = -p * s + q * c;
        }
        return m;
    }
    function m4RotZ(m, a) {
        const c = Math.cos(a), s = Math.sin(a);
        for (let i = 0; i < 4; i++) {
            const p = m[i], q = m[4 + i];
            m[i] = p * c + q * s;
            m[4 + i] = -p * s + q * c;
        }
        return m;
    }
    function m4Scale(m, x, y, z) {
        for (let i = 0; i < 4; i++) {
            m[i] *= x;
            m[4 + i] *= y;
            m[8 + i] *= z;
        }
        return m;
    }
    /** Normal matrix (cofactor of the upper 3x3) - correct under non-uniform scale. Output is column-major mat3. */
    function m4NormalMat3(out, m) {
        const a00 = m[0], a01 = m[1], a02 = m[2];
        const a10 = m[4], a11 = m[5], a12 = m[6];
        const a20 = m[8], a21 = m[9], a22 = m[10];
        out[0] = a11 * a22 - a12 * a21;
        out[1] = a12 * a20 - a10 * a22;
        out[2] = a10 * a21 - a11 * a20;
        out[3] = a02 * a21 - a01 * a22;
        out[4] = a00 * a22 - a02 * a20;
        out[5] = a01 * a20 - a00 * a21;
        out[6] = a01 * a12 - a02 * a11;
        out[7] = a02 * a10 - a00 * a12;
        out[8] = a00 * a11 - a01 * a10;
        return out;
    }
    /** Fixed-depth matrix stack for hierarchical (skeleton) drawing without per-frame allocation. */
    class MatStack {
        stack;
        depth = 0;
        constructor(depth = 24) {
            this.stack = Array.from({ length: depth }, () => (0, exports.mat4)());
        }
        get m() {
            return this.stack[this.depth];
        }
        reset() {
            this.depth = 0;
            m4Identity(this.stack[0]);
            return this;
        }
        push() {
            const next = this.stack[this.depth + 1];
            if (!next)
                throw new Error('MatStack overflow');
            next.set(this.stack[this.depth]);
            this.depth++;
            return this;
        }
        pop() {
            if (this.depth === 0)
                throw new Error('MatStack underflow');
            this.depth--;
            return this;
        }
        translate(x, y, z) { m4Translate(this.m, x, y, z); return this; }
        rotX(a) { m4RotX(this.m, a); return this; }
        rotY(a) { m4RotY(this.m, a); return this; }
        rotZ(a) { m4RotZ(this.m, a); return this; }
        scale(x, y, z) { m4Scale(this.m, x, y, z); return this; }
    }
    exports.MatStack = MatStack;
});
define("combat/FighterController", ["require", "exports", "math", "combat/HitDetection", "characters/TransformationSystem"], function (require, exports, math_js_1, HitDetection_js_1, TransformationSystem_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.ULT_COOLDOWN = exports.PERFECT_GUARD_WINDOW = exports.SLIDE_FRICTION = exports.GRAVITY = void 0;
    exports.updateFighter = updateFighter;
    exports.lungeActive = lungeActive;
    exports.canUltimate = canUltimate;
    exports.startAttack = startAttack;
    exports.integrate = integrate;
    exports.GRAVITY = 55;
    exports.SLIDE_FRICTION = 20;
    exports.PERFECT_GUARD_WINDOW = 0.14;
    const BUFFER_TTL = 0.22;
    const GUARD_LOCK = 0.28;
    const GUARD_REGEN = 22;
    /** Seconds before another ultimate may start (also stops spam with infinite energy). */
    exports.ULT_COOLDOWN = 5;
    function pickIntent(f, inp) {
        const p = inp.pressed;
        if (p.dodge)
            return 'dodge';
        if (p.grab)
            return 'grab';
        if (p.special)
            return 'special';
        if (p.heavy)
            return 'heavy';
        if (p.light)
            return 'light';
        if (p.jump)
            return 'jump';
        const b = f.buffer;
        if (b && b.ttl > 0 && b.action !== 'beam')
            return b.action;
        return null;
    }
    /** Remember a press made while busy so it fires the instant the fighter is free. */
    function bufferIntent(f, inp) {
        const p = inp.pressed;
        const action = p.dodge ? 'dodge' : p.grab ? 'grab' : p.special ? 'special' : p.heavy ? 'heavy' : p.light ? 'light' : p.jump ? 'jump' : null;
        if (action)
            f.buffer = { action, ttl: BUFFER_TTL };
    }
    function totalTime(a) {
        return a.startup + a.active + a.recovery;
    }
    function applyModifiers(f) {
        let power = 1;
        let speed = 1;
        const t = f.def.timer;
        if (t && f.timerExpired) {
            power *= t.powerMul;
            speed *= t.speedMul;
        }
        const e = f.def.enrage;
        if (e) {
            if (f.hp > 0 && f.hp / f.stats.maxHp <= e.belowHp) {
                power *= e.powerMul;
                speed *= e.speedMul;
                f.enraged = true;
            }
        }
        f.powerMul = power;
        f.speedMul = speed;
    }
    function tickTimers(b, f, dt) {
        f.invuln = Math.max(0, f.invuln - dt);
        f.lock = Math.max(0, f.lock - dt);
        f.dodgeCooldown = Math.max(0, f.dodgeCooldown - dt);
        f.specialCooldown = Math.max(0, f.specialCooldown - dt);
        f.beamCooldown = Math.max(0, f.beamCooldown - dt);
        f.guardLock = Math.max(0, f.guardLock - dt);
        f.guardRegenDelay = Math.max(0, f.guardRegenDelay - dt);
        f.techWindow = Math.max(0, f.techWindow - dt);
        f.formCooldown = Math.max(0, f.formCooldown - dt);
        f.ultimateCooldown = Math.max(0, f.ultimateCooldown - dt);
        f.mash = Math.max(0, f.mash - dt * 2.5);
        if (f.buffer) {
            f.buffer.ttl -= dt;
            if (f.buffer.ttl <= 0)
                f.buffer = null;
        }
        // Combo bookkeeping only runs down once the victim is back in control.
        if (f.hitsTaken > 0 && (f.neutral || f.state === 'jump')) {
            f.comboTimer -= dt;
            if (f.comboTimer <= 0) {
                f.hitsTaken = 0;
                f.comboDamage = 0;
            }
        }
        if (f.guardRegenDelay <= 0 && f.state !== 'guard') {
            f.guard = Math.min(f.stats.maxGuard, f.guard + GUARD_REGEN * dt);
        }
        if (f.state === 'idle' || f.state === 'walk' || f.state === 'guard') {
            f.energy = Math.min(f.stats.maxEnergy, f.energy + f.stats.energyRegen * dt);
        }
        if (b.controlsEnabled && f.alive && f.def.timer && !f.timerExpired) {
            f.timerLeft -= dt;
            if (f.timerLeft <= 0) {
                f.timerLeft = 0;
                f.timerExpired = true;
                b.emit({ type: 'timerExpired', fighter: f.index });
            }
        }
        // Ultimate meter: announce once when it becomes usable.
        const ult = f.def.moves.ultimate;
        const ultUsable = f.ultimate === null && f.ultimateCooldown <= 0 && f.energy >= ult.energyCost && f.alive;
        if (ultUsable) {
            if (!f.ultReady && b.controlsEnabled) {
                f.ultReady = true;
                b.emit({ type: 'ultimateReady', fighter: f.index });
            }
        }
        else {
            f.ultReady = false;
        }
        // Timed forms wear off on their own (only while a match is actually running).
        if (b.controlsEnabled && f.formIndex >= 0 && f.formTimer > 0 && f.state !== 'transform') {
            f.formTimer -= dt;
            if (f.formTimer <= 0) {
                f.applyForm(-1);
                f.formCooldown = Math.max(f.formCooldown, TransformationSystem_js_2.REVERT_COOLDOWN);
                b.emit({ type: 'transform', fighter: f.index, x: f.x, y: f.y + f.height * 0.5, z: f.z, form: '', revert: true, color: f.baseDef.rig.colors.glow });
            }
        }
        applyModifiers(f);
    }
    // ---------------------------------------------------------------- transformation
    function startTransform(b, f) {
        const target = (0, TransformationSystem_js_2.nextFormIndex)(f.baseDef, f.formIndex);
        const forms = f.baseDef.forms;
        const revert = target < 0;
        if (!revert && forms)
            f.energy -= forms[target].energyCost;
        f.pendingForm = target;
        f.buffer = null;
        f.setState('transform', (0, TransformationSystem_js_2.windupOf)(revert ? null : (forms?.[target] ?? null)));
        const color = revert ? f.baseDef.rig.colors.glow : (forms?.[target].aura ?? f.baseDef.rig.colors.glow);
        b.emit({ type: 'transformStart', fighter: f.index, x: f.x, y: f.y + f.height * 0.5, z: f.z, color });
    }
    function finishTransform(b, f) {
        const target = f.pendingForm;
        f.applyForm(target);
        f.pendingForm = -1;
        const form = f.form;
        f.formCooldown = form ? form.cooldown : TransformationSystem_js_2.REVERT_COOLDOWN;
        f.lock = 0.12;
        f.setState('idle');
        // The final burst shoves a nearby opponent back (no damage) so a completed change buys breathing room.
        const burst = form?.burst ?? 0;
        if (burst > 0) {
            const opp = b.fighters[1 - f.index];
            const dx = opp.x - f.x;
            const dz = opp.z - f.z;
            const dist = Math.hypot(dx, dz) || 1;
            if (opp.alive && opp.grounded && !opp.untouchable && dist - opp.radius - f.radius < 10) {
                opp.vx += (dx / dist) * 16 * burst;
                opp.vz += (dz / dist) * 16 * burst;
            }
            b.emit({ type: 'shake', amount: 0.35 * burst });
        }
        b.emit({
            type: 'transform', fighter: f.index, x: f.x, y: f.y + f.height * 0.5, z: f.z,
            form: form?.name ?? '', revert: !form, color: form?.aura ?? f.baseDef.rig.colors.glow,
        });
    }
    /** Per-tick behaviour of one fighter: input -> state machine. Physics happens in `integrate`. */
    function updateFighter(b, f, inp, dt) {
        const opp = b.fighters[1 - f.index];
        f.stateTime += dt;
        tickTimers(b, f, dt);
        switch (f.state) {
            case 'idle':
            case 'walk':
            case 'guard':
                neutralTick(b, f, opp, inp, dt);
                break;
            case 'jump':
                airTick(b, f, opp, inp, dt);
                break;
            case 'attack':
                attackTick(b, f, opp, inp, dt);
                break;
            case 'dodge':
                f.yaw = (0, math_js_1.turnToward)(f.yaw, (0, HitDetection_js_1.bearing)(f, opp), f.stats.turnRate * 0.6 * dt);
                bufferIntent(f, inp);
                f.stateTimer -= dt;
                if (f.stateTimer <= 0) {
                    f.lock = 0.1;
                    f.setState('idle');
                }
                break;
            case 'hitstun':
            case 'blockstun':
                if (f.state === 'blockstun')
                    bufferIntent(f, inp);
                f.stateTimer -= dt;
                if (f.stateTimer <= 0)
                    f.setState('idle');
                break;
            case 'launched':
                // Landing handled in integrate().
                break;
            case 'down':
                f.stateTimer -= dt;
                if (f.stateTimer <= 0) {
                    f.setState('getup', 0.45);
                    f.invuln = Math.max(f.invuln, 0.45);
                }
                break;
            case 'getup':
                f.yaw = (0, math_js_1.turnToward)(f.yaw, (0, HitDetection_js_1.bearing)(f, opp), f.stats.turnRate * 0.5 * dt);
                f.stateTimer -= dt;
                if (f.stateTimer <= 0)
                    f.setState('idle');
                break;
            case 'charge':
                chargeTick(b, f, opp, inp, dt);
                break;
            case 'transform':
                f.yaw = (0, math_js_1.turnToward)(f.yaw, (0, HitDetection_js_1.bearing)(f, opp), f.stats.turnRate * 0.3 * dt);
                accelerateToward(f, 0, 0, f.stats.accel * dt);
                f.flash = Math.max(f.flash, 0.45); // glow while changing
                f.stateTimer -= dt;
                if (f.stateTimer <= 0)
                    finishTransform(b, f);
                break;
            case 'beam':
                if (!b.beamOf(f.index)) {
                    f.lock = f.def.moves.beam.recovery;
                    f.setState('idle');
                }
                break;
            case 'grabbing':
                grabbingTick(b, f, dt);
                break;
            case 'grabbed':
                if (inp.pressed.grab && f.techWindow > 0)
                    b.techBreak(f);
                break;
            case 'defeated':
            case 'victory':
                break;
        }
    }
    // ------------------------------------------------------------------ neutral
    function neutralTick(b, f, opp, inp, dt) {
        f.yaw = (0, math_js_1.turnToward)(f.yaw, (0, HitDetection_js_1.bearing)(f, opp), f.stats.turnRate * dt);
        if (f.lock <= 0) {
            const intent = pickIntent(f, inp);
            if (intent) {
                const done = tryIntent(b, f, inp, intent);
                f.buffer = null;
                if (done)
                    return;
            }
            if (inp.pressed.ultimate) {
                if (canUltimate(f)) {
                    startUltimate(b, f);
                    return;
                }
                b.emit({ type: 'denied', fighter: f.index, what: 'ultimate', reason: f.ultimateCooldown > 0 ? 'cooldown' : 'energy' });
            }
            if (inp.pressed.alt) {
                if ((0, TransformationSystem_js_2.canTransform)(f)) {
                    startTransform(b, f);
                    return;
                }
                const has = (f.baseDef.forms?.length ?? 0) > 0;
                b.emit({ type: 'denied', fighter: f.index, what: 'transform', reason: !has ? 'none' : f.formCooldown > 0 ? 'cooldown' : 'energy' });
            }
            if (inp.pressed.beam && canStartCharge(f)) {
                startCharge(b, f);
                return;
            }
        }
        const wantGuard = inp.held.guard && f.guardLock <= 0 && f.guard > 5 && f.lock <= 0;
        if (wantGuard) {
            if (f.state !== 'guard') {
                f.setState('guard');
                f.guardAge = 0;
            }
            f.guardAge += dt;
        }
        else if (f.state === 'guard') {
            f.guardLock = GUARD_LOCK;
            f.setState('idle');
        }
        const guarding = f.state === 'guard';
        const speed = f.stats.speed * f.speedMul * (guarding ? 0.45 : 1);
        const ix = inp.moveX;
        const iy = inp.moveY;
        const mag = Math.hypot(ix, iy);
        const nx = mag > 1 ? ix / mag : ix;
        const ny = mag > 1 ? iy / mag : iy;
        const lf = (ny > 0 ? ny : ny * 0.62) * speed; // along facing
        const ls = nx * 0.85 * speed; // sideways (+ = character's right)
        const rightX = -f.forwardZ;
        const rightZ = f.forwardX;
        const tx = f.forwardX * lf + rightX * ls;
        const tz = f.forwardZ * lf + rightZ * ls;
        accelerateToward(f, tx, tz, f.stats.accel * dt);
        if (!guarding) {
            const moving = mag > 0.15;
            if (moving && f.state !== 'walk')
                f.setState('walk');
            else if (!moving && f.state === 'walk')
                f.setState('idle');
        }
    }
    function accelerateToward(f, tx, tz, maxDelta) {
        const dx = tx - f.vx;
        const dz = tz - f.vz;
        const d = Math.hypot(dx, dz);
        if (d <= maxDelta || d < 1e-6) {
            f.vx = tx;
            f.vz = tz;
        }
        else {
            f.vx += (dx / d) * maxDelta;
            f.vz += (dz / d) * maxDelta;
        }
    }
    function tryIntent(b, f, inp, intent) {
        const m = f.def.moves;
        switch (intent) {
            case 'dodge':
                if (f.dodgeCooldown > 0)
                    return false;
                startDodge(b, f, inp);
                return true;
            case 'jump':
                if (!f.grounded)
                    return false;
                startJump(b, f, inp);
                return true;
            case 'grab':
                startAttack(b, f, m.grab);
                return true;
            case 'special':
                if (f.specialCooldown > 0 || f.energy < m.special.energyCost)
                    return false;
                startAttack(b, f, m.special);
                return true;
            case 'heavy':
                startAttack(b, f, inp.moveY > 0.5 ? m.heavyForward : m.heavy);
                return true;
            case 'light':
                startAttack(b, f, m.lights[0]);
                return true;
        }
    }
    // ------------------------------------------------------------------- attacks
    /** True while the fighter is inside the forward-rush part of a lunging attack. */
    function lungeActive(f) {
        const a = f.attack;
        if (f.state !== 'attack' || !a || a.lungeSpeed === undefined)
            return false;
        const start = a.lungeStart ?? 0;
        return f.attackTime >= start && f.attackTime < start + (a.lungeTime ?? a.startup + a.active);
    }
    /** Ultimate rules: full-enough meter, grounded, not already in one, and off cooldown. */
    function canUltimate(f) {
        const u = f.def.moves.ultimate;
        return f.ultimate === null && f.ultimateCooldown <= 0 && f.grounded && f.energy >= u.energyCost;
    }
    function startUltimate(b, f) {
        const u = f.def.moves.ultimate;
        f.energy -= u.energyCost; // spent now - lost if the ultimate is interrupted
        f.ultimateCooldown = exports.ULT_COOLDOWN;
        f.ultimate = u;
        f.ultFired = false;
        f.ultReady = false;
        f.buffer = null;
        startAttack(b, f, u.attack);
        b.emit({ type: 'ultimateStart', fighter: f.index, x: f.x, y: f.y + f.height * 0.5, z: f.z });
    }
    function fireUltimateBeam(b, f) {
        const u = f.ultimate;
        if (!u || !u.beam) {
            endAttack(b, f);
            return;
        }
        f.attack = null;
        f.setState('beam');
        b.spawnBeam(f, 1, u.beam, u.beamPower ?? 4);
    }
    function startAttack(b, f, def) {
        f.attack = def;
        f.attackTime = 0;
        f.attackConnected = false;
        f.subHit = -1;
        f.firedProjectile = false;
        f.energy = Math.max(0, f.energy - def.energyCost);
        if (def.cooldown)
            f.specialCooldown = def.cooldown;
        f.setState('attack');
        f.guardAge = 1;
        b.emit({ type: 'swing', fighter: f.index, heavy: def.damage >= 70 });
    }
    function attackTick(b, f, opp, inp, dt) {
        const a = f.attack;
        if (!a) {
            f.setState('idle');
            return;
        }
        f.attackTime += dt;
        const t = f.attackTime;
        const inActive = t >= a.startup && t < a.startup + a.active;
        if (t < a.startup || (a.tracks && inActive)) {
            f.yaw = (0, math_js_1.turnToward)(f.yaw, (0, HitDetection_js_1.bearing)(f, opp), f.stats.turnRate * dt);
        }
        if (a.lungeSpeed && lungeActive(f)) {
            const s = a.lungeSpeed * f.speedMul;
            f.vx = f.forwardX * s;
            f.vz = f.forwardZ * s;
        }
        if (t >= a.startup) {
            if (f.ultimate && !f.ultFired) {
                f.ultFired = true;
                b.emit({ type: 'ultimateFire', fighter: f.index, x: f.x, y: f.y + f.height * 0.5, z: f.z });
            }
            if (a.type === 'beam') {
                if (!f.firedProjectile) {
                    f.firedProjectile = true;
                    fireUltimateBeam(b, f);
                }
                return; // the beam system owns this fighter from here
            }
            if (a.type === 'projectile') {
                if (!f.firedProjectile) {
                    f.firedProjectile = true;
                    b.spawnProjectile(f, a);
                }
            }
            else if (a.type === 'aoe') {
                if (!f.firedProjectile) {
                    f.firedProjectile = true;
                    b.doAoe(f, a);
                }
            }
            else {
                b.resolveMelee(f);
            }
            // resolveMelee may have turned this into a grab or the hit may have changed our state
            if (f.state !== 'attack')
                return;
        }
        // Ultimate cancel: a connected move can be cancelled into the ultimate (costs the full meter).
        if (f.ultimate === null && inp.pressed.ultimate && f.attackConnected && a.cancelAt !== undefined && t >= a.cancelAt && canUltimate(f)) {
            startUltimate(b, f);
            return;
        }
        const intent = pickIntent(f, inp);
        if (intent && f.attackConnected && a.cancelAt !== undefined && t >= a.cancelAt && tryCancel(b, f, inp, intent)) {
            f.buffer = null;
            return;
        }
        if (intent || inp.pressed.light || inp.pressed.heavy || inp.pressed.special || inp.pressed.grab || inp.pressed.jump || inp.pressed.dodge) {
            bufferIntent(f, inp);
        }
        if (t >= totalTime(a))
            endAttack(b, f);
    }
    function tryCancel(b, f, inp, intent) {
        const a = f.attack;
        if (!a)
            return false;
        const m = f.def.moves;
        const idx = m.lights.indexOf(a);
        const isHeavy = a === m.heavy || a === m.heavyForward;
        if (intent === 'light' && idx >= 0 && idx + 1 < m.lights.length) {
            startAttack(b, f, m.lights[idx + 1]);
            return true;
        }
        if (intent === 'heavy' && idx >= 0) {
            startAttack(b, f, inp.moveY > 0.5 ? m.heavyForward : m.heavy);
            return true;
        }
        if (intent === 'special' && (idx >= 0 || isHeavy) && f.specialCooldown <= 0 && f.energy >= m.special.energyCost) {
            startAttack(b, f, m.special);
            return true;
        }
        return false;
    }
    function endAttack(b, f) {
        if (f.ultimate)
            b.finishUltimate(f, false);
        f.attack = null;
        if (f.grounded)
            f.setState('idle');
        else
            f.setState('jump');
    }
    // -------------------------------------------------------------------- dodge
    function startDodge(b, f, inp) {
        f.perfectDodged = false;
        f.dodgeCooldown = f.stats.dodgeCooldown;
        f.invuln = f.stats.dodgeInvuln;
        let lf = inp.moveY > 0.35 ? 1 : inp.moveY < -0.35 ? -1 : 0;
        const ls = Math.abs(inp.moveX) > 0.35 ? Math.sign(inp.moveX) : 0;
        if (lf === 0 && ls === 0)
            lf = -1; // neutral dodge = back-step
        const len = Math.hypot(lf, ls) || 1;
        const rightX = -f.forwardZ;
        const rightZ = f.forwardX;
        const s = f.stats.dodgeSpeed * f.speedMul;
        f.vx = (f.forwardX * lf + rightX * ls) * (s / len);
        f.vz = (f.forwardZ * lf + rightZ * ls) * (s / len);
        f.setState('dodge', f.stats.dodgeTime);
        b.emit({ type: 'dodge', fighter: f.index, x: f.x, y: f.y, z: f.z });
    }
    // --------------------------------------------------------------------- jump
    function startJump(b, f, inp) {
        const mag = Math.min(1, Math.hypot(inp.moveX, inp.moveY));
        const rightX = -f.forwardZ;
        const rightZ = f.forwardX;
        const s = f.stats.speed * 0.9 * f.speedMul * mag;
        if (mag > 0.2) {
            f.vx = (f.forwardX * inp.moveY + rightX * inp.moveX) * s / mag;
            f.vz = (f.forwardZ * inp.moveY + rightZ * inp.moveX) * s / mag;
        }
        f.y = 0.02;
        f.vy = f.stats.jumpSpeed;
        f.airAttackUsed = false;
        f.setState('jump');
        b.emit({ type: 'jump', fighter: f.index, x: f.x, y: 0, z: f.z });
    }
    function airTick(b, f, opp, inp, dt) {
        f.yaw = (0, math_js_1.turnToward)(f.yaw, (0, HitDetection_js_1.bearing)(f, opp), f.stats.turnRate * 0.6 * dt);
        const p = inp.pressed;
        if (!f.airAttackUsed && (p.light || p.heavy || p.special)) {
            f.airAttackUsed = true;
            startAttack(b, f, f.def.moves.jumpAttack);
            return;
        }
        const rightX = -f.forwardZ;
        const rightZ = f.forwardX;
        const s = f.stats.speed * 0.9 * f.speedMul;
        accelerateToward(f, (f.forwardX * inp.moveY + rightX * inp.moveX) * s, (f.forwardZ * inp.moveY + rightZ * inp.moveX) * s, f.stats.accel * 0.4 * dt);
    }
    // --------------------------------------------------------------------- beam
    function canStartCharge(f) {
        return f.beamCooldown <= 0 && f.energy >= f.def.moves.beam.energyCost;
    }
    function startCharge(b, f) {
        f.energy -= f.def.moves.beam.energyCost;
        f.chargeTime = 0;
        f.setState('charge');
        b.emit({ type: 'chargeStart', fighter: f.index });
    }
    function chargeTick(b, f, opp, inp, dt) {
        const beam = f.def.moves.beam;
        f.yaw = (0, math_js_1.turnToward)(f.yaw, (0, HitDetection_js_1.bearing)(f, opp), f.stats.turnRate * 0.5 * dt);
        f.chargeTime += dt;
        // Bailing out of a charge wastes the energy - that is the price of cancelling.
        if (inp.pressed.guard || inp.pressed.dodge) {
            f.chargeTime = 0;
            f.lock = 0.25;
            f.setState('idle');
            return;
        }
        const full = f.chargeTime >= beam.maxCharge;
        if (!inp.held.beam || full) {
            if (f.chargeTime >= beam.minCharge) {
                const ratio = (0, math_js_1.clamp)((f.chargeTime - beam.minCharge) / Math.max(0.001, beam.maxCharge - beam.minCharge), 0, 1);
                f.chargeTime = 0;
                f.beamCooldown = 0.8;
                f.setState('beam');
                b.spawnBeam(f, ratio);
            }
            else {
                f.chargeTime = 0;
                f.lock = 0.35;
                f.setState('idle');
            }
        }
    }
    // -------------------------------------------------------------------- grabs
    function grabbingTick(b, f, dt) {
        const t = b.fighters[f.grabPartner];
        if (!t || t.state !== 'grabbed') {
            f.grabPartner = -1;
            f.attack = null;
            f.lock = 0.15;
            f.setState('idle');
            return;
        }
        // Hold the victim in front of us while the throw animation plays.
        t.x = f.x + f.forwardX * (f.radius + t.radius * 0.6);
        t.z = f.z + f.forwardZ * (f.radius + t.radius * 0.6);
        t.yaw = f.yaw + Math.PI;
        f.stateTimer -= dt;
        if (f.stateTimer <= 0)
            b.executeThrow(f);
    }
    // ------------------------------------------------------------------ physics
    /** Gravity, movement, friction, landing and arena bounds. */
    function integrate(b, f, dt) {
        if (f.state === 'grabbed') {
            f.vx = f.vz = 0;
        }
        // Gravity
        if (f.y > 0 || f.vy > 0)
            f.vy -= exports.GRAVITY * dt;
        f.x += f.vx * dt;
        f.z += f.vz * dt;
        f.y += f.vy * dt;
        if (f.y <= 0 && f.vy <= 0) {
            const impact = -f.vy;
            const wasAir = f.y < -0.0001 || impact > 0;
            f.y = 0;
            f.vy = 0;
            if (wasAir && impact > 1)
                onLand(b, f, impact);
        }
        // Friction: neutral states steer themselves; everything else slides to a stop.
        if (f.grounded) {
            const steered = f.state === 'idle' || f.state === 'walk' || f.state === 'guard';
            const lunging = lungeActive(f);
            if (!steered && !lunging && f.state !== 'dodge') {
                const sp = Math.hypot(f.vx, f.vz);
                if (sp > 0) {
                    const ns = (0, math_js_1.approach)(sp, 0, exports.SLIDE_FRICTION * dt);
                    f.vx *= ns / sp;
                    f.vz *= ns / sp;
                }
            }
            else if (f.state === 'dodge') {
                const sp = Math.hypot(f.vx, f.vz);
                if (sp > 0) {
                    const ns = (0, math_js_1.approach)(sp, 0, exports.SLIDE_FRICTION * 0.4 * dt);
                    f.vx *= ns / sp;
                    f.vz *= ns / sp;
                }
            }
        }
        // Arena boundary
        const lim = b.radius - f.radius;
        const d = Math.hypot(f.x, f.z);
        if (d > lim) {
            const nx = f.x / d;
            const nz = f.z / d;
            f.x = nx * lim;
            f.z = nz * lim;
            const outward = f.vx * nx + f.vz * nz;
            if (outward > 0) {
                f.vx -= nx * outward;
                f.vz -= nz * outward;
            }
        }
        // Animation helpers (velocity in the fighter's own frame)
        const fx = f.forwardX;
        const fz = f.forwardZ;
        f.localVx = f.vx * fx + f.vz * fz;
        f.localVz = -(f.vx * -fz + f.vz * fx);
        f.walkSpeedFrac = Math.min(1.5, Math.hypot(f.vx, f.vz) / Math.max(1, f.stats.speed));
    }
    function onLand(b, f, impact) {
        const strength = (0, math_js_1.clamp)(impact / 25, 0.15, 1.5);
        if (f.state === 'launched') {
            f.juggle = 0;
            if (f.hp <= 0) {
                f.setState('defeated');
            }
            else {
                f.setState('down', 0.9);
            }
            b.emit({ type: 'land', x: f.x, y: 0, z: f.z, fighter: f.index, strength });
            b.emit({ type: 'shake', amount: 0.2 + strength * 0.3 });
            b.damageProps(f.x, f.z, f.radius * 1.4, 70 * strength);
        }
        else if (f.state === 'jump') {
            f.lock = 0.08;
            f.setState('idle');
            b.emit({ type: 'land', x: f.x, y: 0, z: f.z, fighter: f.index, strength: strength * 0.6 });
        }
        else if (f.state === 'attack' && f.attack?.air) {
            f.attack = null;
            f.lock = 0.18;
            f.setState('idle');
            b.emit({ type: 'land', x: f.x, y: 0, z: f.z, fighter: f.index, strength: strength * 0.8 });
            b.emit({ type: 'shake', amount: 0.15 });
        }
    }
});
define("combat/BeamClashSystem", ["require", "exports", "math"], function (require, exports, math_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CLASH_MAX_TIME = void 0;
    exports.detectClash = detectClash;
    exports.updateClash = updateClash;
    exports.CLASH_MAX_TIME = 3.6;
    /** How fast the contact point drifts per second at a 100% power advantage. */
    const DRIFT = 0.5;
    /** Starts a clash when two opposing beams are aimed at each other. */
    function detectClash(b) {
        if (b.clash)
            return;
        const [ba, bb] = [b.beamOf(0), b.beamOf(1)];
        if (!ba || !bb)
            return;
        const [fa, fb] = b.fighters;
        if (!b.beamReaches(ba, fb) || !b.beamReaches(bb, fa))
            return;
        const dist = Math.hypot(fb.x - fa.x, fb.z - fa.z);
        const clash = {
            a: ba, b: bb, balance: 0.5, time: 0, powerA: ba.power, powerB: bb.power,
            x: (fa.x + fb.x) / 2, y: ba.originY, z: (fa.z + fb.z) / 2,
        };
        ba.clashing = true;
        bb.clashing = true;
        b.clash = clash;
        // Make the two attackers stand their ground while they push.
        fa.vx = fa.vz = fb.vx = fb.vz = 0;
        b.emit({ type: 'clashStart', x: clash.x, y: clash.y, z: clash.z });
        b.emit({ type: 'shake', amount: 0.3 });
        void dist;
    }
    /**
     * Resolves the push-of-war. Strength = charge ratio (committed before the clash) plus button mashing.
     * Advantage is deterministic: equal power with equal mashing stays at a stalemate until the timer expires.
     */
    function updateClash(b, dt) {
        const c = b.clash;
        if (!c)
            return;
        const [fa, fb] = b.fighters;
        const inputs = b.lastInputs;
        c.time += dt;
        // Mash: every press of beam/special/light inside a clash adds momentum.
        for (let i = 0; i < 2; i++) {
            const p = inputs[i].pressed;
            if (b.controlsEnabled && (p.beam || p.special || p.light || p.heavy)) {
                b.fighters[i].mash = Math.min(6, b.fighters[i].mash + 1);
            }
        }
        c.powerA = c.a.power * (1 + 0.22 * fa.mash);
        c.powerB = c.b.power * (1 + 0.22 * fb.mash);
        const adv = (c.powerA - c.powerB) / (c.powerA + c.powerB);
        c.balance = (0, math_js_2.clamp)(c.balance + adv * DRIFT * dt * 2, 0, 1);
        const sx = fa.x, sz = fa.z, ex = fb.x, ez = fb.z;
        c.x = sx + (ex - sx) * c.balance;
        c.z = sz + (ez - sz) * c.balance;
        const dist = Math.hypot(ex - sx, ez - sz);
        c.a.drawLength = dist * c.balance;
        c.b.drawLength = dist * (1 - c.balance);
        // Keep beams alive for the entire clash.
        c.a.timeLeft = Math.max(c.a.timeLeft, 0.3);
        c.b.timeLeft = Math.max(c.b.timeLeft, 0.3);
        if (c.balance >= 0.97) {
            finish(b, 0);
        }
        else if (c.balance <= 0.03) {
            finish(b, 1);
        }
        else if (c.time >= exports.CLASH_MAX_TIME) {
            finish(b, -1);
        }
    }
    function finish(b, winner) {
        const c = b.clash;
        if (!c)
            return;
        const [fa, fb] = b.fighters;
        const x = c.x, y = c.y, z = c.z;
        const beamA = c.a;
        const beamB = c.b;
        b.clash = null;
        beamA.clashing = false;
        beamB.clashing = false;
        if (winner === -1) {
            // Stalemate: both beams detonate at the contact point and shove both fighters back.
            b.removeBeamOf(0, true);
            b.removeBeamOf(1, true);
            for (const f of [fa, fb]) {
                const dx = f.x - x, dz = f.z - z;
                const len = Math.hypot(dx, dz) || 1;
                f.vx = (dx / len) * 14;
                f.vz = (dz / len) * 14;
                f.setState('hitstun', 0.5);
            }
            b.emit({ type: 'clashEnd', winner: -1, x, y, z });
            b.emit({ type: 'shake', amount: 0.7 });
            return;
        }
        const win = b.fighters[winner];
        const lose = b.fighters[1 - winner];
        const winBeam = winner === 0 ? beamA : beamB;
        // Loser's beam is overwhelmed; winner's beam keeps going and the loser is hit hard.
        b.removeBeamOf(lose.index, false);
        lose.setState('idle');
        b.clashHit(win, lose, winBeam.def, winBeam.power);
        b.emit({ type: 'clashEnd', winner, x, y, z });
        b.emit({ type: 'shake', amount: 0.8 });
    }
});
define("data/stages", ["require", "exports", "math"], function (require, exports, math_js_3) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.STAGES = void 0;
    exports.getStage = getStage;
    exports.buildProps = buildProps;
    exports.buildBackdrop = buildBackdrop;
    const norm = (v) => {
        const l = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0] / l, v[1] / l, v[2] / l];
    };
    exports.STAGES = [
        {
            id: 'neo-city',
            name: 'Neo City District',
            description: 'Daylight downtown. Low towers to smash, skyline all around.',
            radius: 48,
            theme: 'city',
            skyTop: [0.22, 0.48, 0.86],
            skyHorizon: [0.86, 0.86, 0.82],
            fog: [0.78, 0.82, 0.88],
            fogDensity: 0.0055,
            ground: [0.3, 0.32, 0.34],
            groundLine: [0.44, 0.46, 0.5],
            ringGlow: [1, 0.55, 0.15],
            sunDir: norm([-0.5, 0.8, -0.35]),
            sunColor: [1, 0.95, 0.85],
            skyAmbient: [0.45, 0.55, 0.72],
            groundAmbient: [0.3, 0.28, 0.26],
            stars: 0,
            propColor: [0.62, 0.64, 0.68],
            windowColor: [0.5, 0.7, 0.9],
            seed: 11,
        },
        {
            id: 'crimson-caldera',
            name: 'Crimson Caldera',
            description: 'Volcanic battlefield. Basalt spires and a glowing horizon.',
            radius: 48,
            theme: 'volcano',
            skyTop: [0.1, 0.02, 0.04],
            skyHorizon: [0.95, 0.32, 0.1],
            fog: [0.42, 0.12, 0.06],
            fogDensity: 0.0075,
            ground: [0.13, 0.1, 0.09],
            groundLine: [0.5, 0.12, 0.04],
            ringGlow: [1, 0.3, 0.05],
            sunDir: norm([0.3, 0.55, 0.45]),
            sunColor: [1, 0.55, 0.3],
            skyAmbient: [0.5, 0.25, 0.18],
            groundAmbient: [0.32, 0.1, 0.05],
            stars: 0.2,
            propColor: [0.2, 0.16, 0.15],
            windowColor: [1, 0.4, 0.1],
            seed: 23,
        },
        {
            id: 'midnight-metro',
            name: 'Midnight Metropolis',
            description: 'Night city under the stars. Lit windows and neon grid.',
            radius: 48,
            theme: 'night-city',
            skyTop: [0.01, 0.02, 0.08],
            skyHorizon: [0.14, 0.1, 0.32],
            fog: [0.05, 0.05, 0.15],
            fogDensity: 0.0085,
            ground: [0.08, 0.09, 0.13],
            groundLine: [0.2, 0.3, 0.6],
            ringGlow: [0.2, 0.8, 1],
            sunDir: norm([0.3, 0.7, 0.5]),
            sunColor: [0.35, 0.45, 0.9],
            skyAmbient: [0.14, 0.17, 0.34],
            groundAmbient: [0.06, 0.06, 0.1],
            stars: 1,
            propColor: [0.22, 0.24, 0.32],
            windowColor: [1, 0.85, 0.4],
            seed: 37,
        },
    ];
    function getStage(id) {
        return exports.STAGES.find((s) => s.id === id) ?? exports.STAGES[0];
    }
    /** Destructible props inside the arena (deterministic per stage so rounds are repeatable). */
    function buildProps(stage) {
        const rng = new math_js_3.Rng(stage.seed);
        const props = [];
        let id = 1;
        let guard = 0;
        while (props.length < 14 && guard++ < 400) {
            const ang = rng.range(0, Math.PI * 2);
            const rad = rng.range(stage.radius * 0.42, stage.radius * 0.88);
            const x = Math.cos(ang) * rad;
            const z = Math.sin(ang) * rad;
            // Keep the spawn lanes clear.
            if (Math.hypot(x - 13, z) < 10 || Math.hypot(x + 13, z) < 10)
                continue;
            if (props.some((p) => Math.hypot(p.x - x, p.z - z) < 8))
                continue;
            const rock = stage.theme === 'volcano';
            const w = rock ? rng.range(3, 5) : rng.range(3.5, 5.5);
            const h = rock ? rng.range(3.5, 7) : rng.range(3.5, 7);
            const tint = rng.range(0.85, 1.1);
            const base = stage.propColor;
            props.push({
                id: id++,
                kind: rock ? 'rock' : stage.theme === 'night-city' ? 'tower' : 'building',
                x, z, w, d: rock ? w : rng.range(3.5, 5.5), h,
                hp: 90 + h * 12, maxHp: 90 + h * 12,
                rot: rng.range(0, Math.PI),
                color: [base[0] * tint, base[1] * tint, base[2] * tint],
                alive: true,
            });
        }
        return props;
    }
    /** Static scenery outside the playable disc (render only, never simulated). */
    function buildBackdrop(stage, density = 1) {
        const rng = new math_js_3.Rng(stage.seed * 7 + 3);
        const items = [];
        // Inner edge of the nearest ring stays > radius + 8 so the (clamped) camera never clips scenery.
        const rings = [stage.radius + 19, stage.radius + 38, stage.radius + 62];
        const count = [26, 30, 34];
        rings.forEach((r, ri) => {
            const n = Math.round(count[ri] * density);
            for (let i = 0; i < n; i++) {
                const ang = (i / n) * Math.PI * 2 + rng.range(-0.08, 0.08);
                const rad = r + rng.range(-1, 6);
                const rock = stage.theme === 'volcano';
                const w = rock ? rng.range(8, 18) : rng.range(6, 12);
                const h = rock ? rng.range(12, 40 + ri * 16) : rng.range(8, 22 + ri * 16);
                items.push({
                    x: Math.cos(ang) * rad, z: Math.sin(ang) * rad, w, d: rock ? w : rng.range(6, 12), h,
                    rot: rng.range(0, Math.PI), shade: rng.range(0.75, 1.15),
                });
            }
        });
        return items;
    }
});
define("combat/Battle", ["require", "exports", "combat/Fighter", "combat/types", "combat/DamageSystem", "combat/HitDetection", "combat/FighterController", "combat/BeamClashSystem", "data/stages", "math"], function (require, exports, Fighter_js_1, types_js_1, DamageSystem_js_1, HitDetection_js_2, FighterController_js_1, BeamClashSystem_js_1, stages_js_1, math_js_4) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Battle = exports.PERFECT_DODGE_WINDOW = exports.COMBO_HARD_CAP = exports.JUGGLE_MAX = exports.START_SEPARATION = void 0;
    exports.START_SEPARATION = 13;
    /** Hits a launched fighter can take before they fall (finite air combos). */
    exports.JUGGLE_MAX = 3;
    /** After this many hits in one combo the next hit knocks the victim down (no infinite strings). */
    exports.COMBO_HARD_CAP = 9;
    /** A dodge that avoids a hit within this many seconds of starting is a PERFECT dodge. */
    exports.PERFECT_DODGE_WINDOW = 0.1;
    /** Renderer-free combat simulation. Deterministic for a given seed and input sequence. */
    class Battle {
        fighters;
        stage;
        radius;
        projectiles = [];
        beams = [];
        clash = null;
        props = [];
        /** Drained by the presentation layer every frame. */
        events = [];
        time = 0;
        hitstop = 0;
        controlsEnabled = false;
        rng;
        options;
        lastInputs = [(0, types_js_1.emptyInput)(), (0, types_js_1.emptyInput)()];
        tick = 0;
        nextId = 1;
        koEmitted = false;
        /** Dodge feedback is rate-limited so a multi-tick attack doesn't spam "evade". */
        evadeCooldown = [0, 0];
        constructor(chars, stage, options = {}) {
            this.stage = stage;
            this.radius = stage.radius;
            this.rng = new math_js_4.Rng(options.seed ?? 1);
            this.options = {
                seed: options.seed ?? 1,
                infiniteHp: options.infiniteHp ?? [false, false],
                infiniteEnergy: options.infiniteEnergy ?? [false, false],
            };
            this.fighters = [new Fighter_js_1.Fighter(0, chars[0]), new Fighter_js_1.Fighter(1, chars[1])];
            this.resetRound();
        }
        emit(e) {
            // Cap runaway event growth if nobody is draining the queue (headless sims).
            if (this.events.length < 512)
                this.events.push(e);
        }
        // ---------------------------------------------------------------- rounds
        resetRound() {
            const [a, b] = this.fighters;
            a.resetForRound();
            b.resetForRound();
            a.x = -exports.START_SEPARATION;
            b.x = exports.START_SEPARATION;
            a.z = 0;
            b.z = 0;
            a.yaw = Math.PI / 2;
            b.yaw = -Math.PI / 2;
            for (const f of this.fighters) {
                f.px = f.x;
                f.py = f.y;
                f.pz = f.z;
                f.pyaw = f.yaw;
            }
            this.projectiles = [];
            this.beams = [];
            this.clash = null;
            this.props = (0, stages_js_1.buildProps)(this.stage);
            this.koEmitted = false;
            this.hitstop = 0;
            this.evadeCooldown = [0, 0];
        }
        /** Round result: undefined while running, -1 for a double KO, otherwise the winner's index. */
        roundWinner() {
            const [a, b] = this.fighters;
            const aDown = a.hp <= 0;
            const bDown = b.hp <= 0;
            if (aDown && bDown)
                return -1;
            if (aDown)
                return 1;
            if (bDown)
                return 0;
            return undefined;
        }
        setVictory(index) {
            const f = this.fighters[index];
            this.removeBeamOf(index, false);
            this.finishUltimate(f, false);
            if (f.alive && f.state !== 'victory') {
                f.setState('victory');
                f.vx = f.vz = 0;
            }
        }
        // ------------------------------------------------------------------ step
        step(dt, inputs) {
            this.time += dt;
            this.lastInputs = inputs;
            for (const f of this.fighters) {
                f.flash = Math.max(0, f.flash - dt * 6);
            }
            this.evadeCooldown[0] = Math.max(0, this.evadeCooldown[0] - dt);
            this.evadeCooldown[1] = Math.max(0, this.evadeCooldown[1] - dt);
            if (this.hitstop > 0) {
                this.hitstop -= dt;
                return;
            }
            this.tick++;
            for (const f of this.fighters) {
                f.px = f.x;
                f.py = f.y;
                f.pz = f.z;
                f.pyaw = f.yaw;
            }
            const order = this.tick % 2 === 0 ? [0, 1] : [1, 0];
            for (const i of order) {
                const f = this.fighters[i];
                const inp = this.controlsEnabled ? inputs[i] : (0, types_js_1.emptyInput)();
                (0, FighterController_js_1.updateFighter)(this, f, inp, dt);
            }
            this.updateProjectiles(dt);
            this.updateBeams(dt);
            for (const f of this.fighters)
                (0, FighterController_js_1.integrate)(this, f, dt);
            this.separate();
            this.updateProps(dt);
            // Practice conveniences
            for (let i = 0; i < 2; i++) {
                const f = this.fighters[i];
                if (this.options.infiniteHp[i])
                    f.hp = f.stats.maxHp;
                if (this.options.infiniteEnergy[i])
                    f.energy = f.stats.maxEnergy;
            }
            if (!this.koEmitted) {
                const w = this.roundWinner();
                if (w !== undefined) {
                    this.koEmitted = true;
                    const loser = w === -1 ? 0 : 1 - w;
                    const l = this.fighters[loser];
                    this.emit({ type: 'ko', loser, x: l.x, y: l.y + l.height * 0.5, z: l.z });
                }
            }
        }
        // ----------------------------------------------------------- body pushing
        separate() {
            const [a, b] = this.fighters;
            if (a.state === 'grabbing' || b.state === 'grabbing' || a.state === 'grabbed' || b.state === 'grabbed')
                return;
            // Airborne fighters pass over each other.
            if (a.y > b.height * 0.7 || b.y > a.height * 0.7)
                return;
            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const dist = Math.hypot(dx, dz);
            const min = a.radius + b.radius;
            if (dist >= min)
                return;
            const nx = dist > 1e-4 ? dx / dist : 1;
            const nz = dist > 1e-4 ? dz / dist : 0;
            const overlap = min - dist;
            const wa = 1 / a.stats.mass;
            const wb = 1 / b.stats.mass;
            const sum = wa + wb;
            a.x -= nx * overlap * (wa / sum);
            a.z -= nz * overlap * (wa / sum);
            b.x += nx * overlap * (wb / sum);
            b.z += nz * overlap * (wb / sum);
        }
        // ------------------------------------------------------------------ props
        damageProps(x, z, radius, amount) {
            for (const p of this.props) {
                if (!p.alive)
                    continue;
                const reach = radius + Math.max(p.w, p.d) * 0.5;
                if (Math.hypot(p.x - x, p.z - z) > reach)
                    continue;
                const before = p.hp;
                p.hp -= amount;
                if (p.hp <= 0) {
                    p.alive = false;
                    this.emit({ type: 'propBroken', x: p.x, y: p.h * 0.5, z: p.z, w: Math.max(p.w, p.d), h: p.h, color: p.color });
                }
                else if (Math.floor((before / p.maxHp) * 3) !== Math.floor((p.hp / p.maxHp) * 3)) {
                    this.emit({ type: 'propHit', x: p.x, y: p.h * 0.6, z: p.z });
                }
            }
        }
        updateProps(dt) {
            // Giants trample whatever they walk through.
            for (const f of this.fighters) {
                if (f.y > 2 || f.state === 'defeated')
                    continue;
                const speed = Math.hypot(f.vx, f.vz);
                if (speed < 2)
                    continue;
                this.damageProps(f.x, f.z, f.radius * 0.8, 160 * dt);
            }
        }
        // ------------------------------------------------------------- projectiles
        spawnProjectile(f, atk) {
            const def = atk.projectile;
            if (!def)
                return;
            const sx = f.x + f.forwardX * (f.radius + 1.2);
            const sz = f.z + f.forwardZ * (f.radius + 1.2);
            const sy = f.y + f.height * def.heightFrac;
            this.projectiles.push({
                id: this.nextId++, owner: f.index, x: sx, y: sy, z: sz,
                vx: f.forwardX * def.speed, vz: f.forwardZ * def.speed,
                radius: def.radius, life: def.life, atk, color: def.color,
            });
            this.emit({ type: 'projectile', owner: f.index, x: sx, y: sy, z: sz });
        }
        updateProjectiles(dt) {
            const keep = [];
            for (const p of this.projectiles) {
                p.life -= dt;
                p.x += p.vx * dt;
                p.z += p.vz * dt;
                let alive = p.life > 0 && Math.hypot(p.x, p.z) < this.radius + 14;
                // Two opposing projectiles cancel each other.
                if (alive) {
                    for (const q of this.projectiles) {
                        if (q === p || q.owner === p.owner || q.life <= 0)
                            continue;
                        if (Math.hypot(q.x - p.x, q.z - p.z, q.y - p.y) < p.radius + q.radius) {
                            alive = false;
                            q.life = 0;
                            this.emit({ type: 'projectileHit', x: p.x, y: p.y, z: p.z, color: p.color });
                            break;
                        }
                    }
                }
                if (alive) {
                    const t = this.fighters[1 - p.owner];
                    const owner = this.fighters[p.owner];
                    const inY = p.y + p.radius >= t.y && p.y - p.radius <= t.y + t.height;
                    if (inY && Math.hypot(t.x - p.x, t.z - p.z) <= p.radius + t.radius) {
                        const len = Math.hypot(p.vx, p.vz) || 1;
                        const info = this.infoFromAttack(p.atk, p.vx / len, p.vz / len, false);
                        const r = this.deliver(owner, t, info, p.x, p.y, p.z, p.atk);
                        if (r !== 'ignored' && r !== 'evade') {
                            alive = false;
                            this.emit({ type: 'projectileHit', x: p.x, y: p.y, z: p.z, color: p.color });
                        }
                    }
                }
                if (alive)
                    this.damageProps(p.x, p.z, p.radius, 60 * dt * 6);
                if (alive)
                    keep.push(p);
            }
            this.projectiles = keep;
        }
        // ------------------------------------------------------------------- AoE
        doAoe(f, atk) {
            const radius = atk.radius ?? 12;
            this.emit({ type: 'stomp', x: f.x, y: 0, z: f.z, radius });
            this.damageProps(f.x, f.z, radius, 400);
            const t = this.fighters[1 - f.index];
            // Shockwave travels along the ground: jumping over it avoids it.
            if (t.y > 1.5)
                return;
            const dist = Math.hypot(t.x - f.x, t.z - f.z);
            if (dist - t.radius > radius)
                return;
            const nx = dist > 1e-4 ? (t.x - f.x) / dist : f.forwardX;
            const nz = dist > 1e-4 ? (t.z - f.z) / dist : f.forwardZ;
            const info = this.infoFromAttack(atk, nx, nz, false);
            const r = this.deliver(f, t, info, t.x - nx * t.radius, t.y + t.height * 0.2, t.z - nz * t.radius, atk);
            if (r !== 'ignored' && r !== 'evade')
                f.subHit = 0;
        }
        // ----------------------------------------------------------------- melee
        resolveMelee(att) {
            const a = att.attack;
            if (!a || (a.type !== 'melee' && a.type !== 'throw'))
                return;
            if (att.attackTime < a.startup || att.attackTime >= a.startup + a.active)
                return;
            const hits = a.hits ?? 1;
            const idx = Math.min(hits - 1, Math.floor(((att.attackTime - a.startup) / a.active) * hits));
            if (idx <= att.subHit)
                return;
            const tgt = this.fighters[1 - att.index];
            if (a.type === 'throw') {
                if (this.canBeGrabbed(tgt) && (0, HitDetection_js_2.meleeConnects)(att, tgt, a)) {
                    att.subHit = idx;
                    this.startGrab(att, tgt, a);
                }
                return;
            }
            if (!(0, HitDetection_js_2.meleeConnects)(att, tgt, a))
                return;
            const dx = tgt.x - att.x;
            const dz = tgt.z - att.z;
            const len = Math.hypot(dx, dz) || 1;
            const info = this.infoFromAttack(a, dx / len, dz / len, true);
            if (a.finale && idx === hits - 1) {
                info.damage += a.finale.damage;
                info.knockback = a.finale.knockback;
                info.launch = a.finale.launch;
                info.knockdown = true;
                info.heavy = true;
                info.hitstop = Math.max(info.hitstop, 0.22);
                info.shake = Math.max(info.shake, 0.85);
            }
            const hx = att.x + att.forwardX * Math.min(a.reach, len);
            const hz = att.z + att.forwardZ * Math.min(a.reach, len);
            const hy = Math.max(att.y, tgt.y) + Math.min(att.height, tgt.height) * 0.62;
            const r = this.deliver(att, tgt, info, hx, hy, hz, a);
            if (r !== 'ignored' && r !== 'evade')
                att.subHit = idx;
        }
        infoFromAttack(a, dirX, dirZ, counterable) {
            return {
                damage: a.damage, hitstun: a.hitstun, blockstun: a.blockstun, knockback: a.knockback,
                launch: a.launch, knockdown: a.knockdown, guardDamage: a.guardDamage, hitstop: a.hitstop,
                shake: a.shake, energyGain: a.energyGain, dirX, dirZ, guardable: a.guardable !== false, counterable,
                noScale: a.noScale === true, noCombo: false, heavy: a.damage >= 70 || a.knockdown,
            };
        }
        // ------------------------------------------------------------------ throws
        canBeGrabbed(t) {
            return t.grounded && !t.untouchable && (t.state === 'idle' || t.state === 'walk' || t.state === 'guard' || t.state === 'attack' || t.state === 'blockstun' || t.state === 'charge' || t.state === 'transform' || t.state === 'dodge' ? t.invuln <= 0 : false);
        }
        startGrab(att, tgt, a) {
            this.interrupt(tgt);
            att.attack = a;
            att.setState('grabbing', 0.6);
            att.grabPartner = tgt.index;
            att.vx = att.vz = 0;
            tgt.setState('grabbed', 5);
            tgt.grabPartner = att.index;
            tgt.techWindow = 0.28;
            tgt.vx = tgt.vz = 0;
            att.attackConnected = true;
            this.hitstop = Math.max(this.hitstop, 0.06);
            this.emit({ type: 'shake', amount: 0.25 });
        }
        /** Called by the grabbing fighter's controller once the hold finishes. */
        executeThrow(att) {
            const tgt = this.fighters[att.grabPartner];
            const a = att.attack;
            if (!tgt || !a)
                return;
            const dmg = (0, DamageSystem_js_1.computeDamage)(a.throwDamage ?? a.damage, att.stats.power * att.powerMul, tgt.stats.defense, 0);
            tgt.hp -= dmg;
            if (this.options.infiniteHp[tgt.index])
                tgt.hp = tgt.stats.maxHp;
            tgt.damageTaken += dmg;
            att.damageDealt += dmg;
            att.hitsLanded++;
            att.energy = Math.min(att.stats.maxEnergy, att.energy + a.energyGain);
            tgt.energy = Math.min(tgt.stats.maxEnergy, tgt.energy + (0, DamageSystem_js_1.energyOnTakingDamage)(dmg));
            tgt.flash = 1;
            tgt.hitsTaken = 1;
            tgt.comboTimer = 0.4;
            att.maxCombo = Math.max(att.maxCombo, 1);
            const dirX = att.forwardX;
            const dirZ = att.forwardZ;
            tgt.x = att.x + dirX * (att.radius + tgt.radius + 0.5);
            tgt.z = att.z + dirZ * (att.radius + tgt.radius + 0.5);
            tgt.grabPartner = -1;
            att.grabPartner = -1;
            if (tgt.hp <= 0) {
                tgt.hp = 0;
                tgt.setState('launched');
                tgt.vy = 15;
            }
            else {
                tgt.setState('launched');
                tgt.vy = 16;
            }
            const sp = (0, DamageSystem_js_1.knockbackSpeed)(a.knockback, tgt.stats.mass);
            tgt.vx = dirX * sp;
            tgt.vz = dirZ * sp;
            att.setState('idle');
            att.attack = null;
            att.lock = 0.3;
            this.hitstop = Math.max(this.hitstop, a.hitstop);
            this.emit({ type: 'throw', x: tgt.x, y: tgt.y + tgt.height * 0.5, z: tgt.z, attacker: att.index, target: tgt.index });
            this.emit({ type: 'shake', amount: a.shake });
        }
        /** Defender pressed grab inside the tech window: both are shoved apart, no damage. */
        techBreak(defender) {
            const att = this.fighters[defender.grabPartner];
            defender.grabPartner = -1;
            defender.techWindow = 0;
            defender.setState('hitstun', 0.3);
            defender.vx = -defender.forwardX * 12;
            defender.vz = -defender.forwardZ * 12;
            if (att) {
                att.grabPartner = -1;
                att.attack = null;
                att.setState('hitstun', 0.3);
                att.vx = -att.forwardX * 12;
                att.vz = -att.forwardZ * 12;
            }
            this.emit({ type: 'techbreak', x: (defender.x + (att?.x ?? defender.x)) / 2, y: defender.height * 0.5, z: (defender.z + (att?.z ?? defender.z)) / 2 });
            this.emit({ type: 'shake', amount: 0.15 });
        }
        /** Cancels whatever the fighter is doing because they were hit. */
        interrupt(t) {
            if (t.state === 'transform') {
                t.pendingForm = -1;
                this.emit({ type: 'transformCancel', fighter: t.index });
            }
            this.finishUltimate(t, true);
            if (t.state === 'beam')
                this.removeBeamOf(t.index, false);
            if (t.state === 'grabbing' && t.grabPartner >= 0) {
                const p = this.fighters[t.grabPartner];
                if (p && p.state === 'grabbed') {
                    p.setState('idle');
                    p.grabPartner = -1;
                    p.lock = 0.1;
                }
                t.grabPartner = -1;
            }
            t.attack = null;
            t.buffer = null;
            t.chargeTime = 0;
        }
        // ------------------------------------------------------------- hit delivery
        /** Single place where every hit (melee, projectile, AoE, beam tick) is resolved. */
        deliver(att, tgt, h, px, py, pz, _src) {
            if (tgt.state === 'defeated')
                return 'ignored';
            if (tgt.state === 'dodge' && tgt.invuln > 0) {
                if (_src && !tgt.perfectDodged && tgt.stateTime <= exports.PERFECT_DODGE_WINDOW) {
                    // Dodged at the last instant: reward with energy and a presentation beat.
                    tgt.perfectDodged = true;
                    tgt.energy = Math.min(tgt.stats.maxEnergy, tgt.energy + 12);
                    this.emit({ type: 'perfectDodge', fighter: tgt.index, x: tgt.x, y: tgt.y + tgt.height * 0.5, z: tgt.z });
                }
                if (this.evadeCooldown[tgt.index] <= 0) {
                    this.evadeCooldown[tgt.index] = 0.4;
                    this.emit({ type: 'evade', x: tgt.x, y: tgt.y + tgt.height * 0.5, z: tgt.z, target: tgt.index });
                }
                return 'evade';
            }
            const canJuggle = tgt.state === 'launched' && tgt.hp > 0 && tgt.invuln <= 0 && tgt.y > 1.5 && tgt.juggle < exports.JUGGLE_MAX && !h.noCombo;
            if (tgt.untouchable && !canJuggle)
                return 'ignored';
            // ---- beam counter-fire: a charger that already holds a minimum charge answers a beam with its own,
            // which is what makes a clash reachable. Strength = whatever was charged at the moment of contact.
            if (h.noCombo && !h.knockdown && tgt.state === 'charge') {
                const bd = tgt.def.moves.beam;
                if (tgt.chargeTime >= bd.minCharge) {
                    const ratio = (0, math_js_4.clamp)((tgt.chargeTime - bd.minCharge) / Math.max(0.001, bd.maxCharge - bd.minCharge), 0, 1);
                    tgt.chargeTime = 0;
                    tgt.beamCooldown = 0.8;
                    tgt.setState('beam');
                    this.spawnBeam(tgt, ratio);
                    return 'ignored';
                }
            }
            // ---- guard
            // A fighter in blockstun is still guarding: later hits of a string or beam are blocked too.
            if ((tgt.state === 'guard' || tgt.state === 'blockstun') && h.guardable && (0, HitDetection_js_2.facingAttacker)(tgt, att.x, att.z)) {
                if (h.counterable && tgt.state === 'guard' && tgt.guardAge <= FighterController_js_1.PERFECT_GUARD_WINDOW) {
                    // Timed guard -> counter: attacker is staggered, defender takes nothing and is immediately free.
                    tgt.counters++;
                    tgt.energy = Math.min(tgt.stats.maxEnergy, tgt.energy + 14);
                    tgt.guardAge = 1;
                    this.interrupt(att);
                    att.setState('hitstun', 0.7);
                    att.attackConnected = false;
                    att.vx = -h.dirX * 9;
                    att.vz = -h.dirZ * 9;
                    att.flash = 0.6;
                    this.hitstop = Math.max(this.hitstop, 0.14);
                    this.emit({ type: 'counter', x: px, y: py, z: pz, target: tgt.index, attacker: att.index });
                    this.emit({ type: 'shake', amount: 0.35 });
                    return 'counter';
                }
                const chip = h.noCombo ? Math.max(0, Math.round(h.damage * 0.02)) : (0, DamageSystem_js_1.chipDamage)(h.damage);
                tgt.hp = Math.max(1, tgt.hp - chip);
                tgt.damageTaken += chip;
                att.damageDealt += chip;
                tgt.blocks++;
                tgt.guardRegenDelay = 1.1;
                const g = (0, DamageSystem_js_1.applyGuardDamage)(tgt.guard, h.guardDamage);
                tgt.guard = g.guard;
                att.attackConnected = true;
                att.energy = Math.min(att.stats.maxEnergy, att.energy + h.energyGain * 0.5);
                if (g.broken) {
                    this.interrupt(tgt);
                    tgt.setState('hitstun', 1.1);
                    tgt.guard = tgt.stats.maxGuard * 0.4;
                    tgt.vx = h.dirX * 6;
                    tgt.vz = h.dirZ * 6;
                    tgt.flash = 1;
                    this.hitstop = Math.max(this.hitstop, 0.12);
                    this.emit({ type: 'guardbreak', x: px, y: py, z: pz, target: tgt.index });
                    this.emit({ type: 'shake', amount: 0.4 });
                    return 'block';
                }
                tgt.setState('blockstun', h.blockstun);
                const sp = (0, DamageSystem_js_1.knockbackSpeed)(h.knockback * 0.45, tgt.stats.mass);
                tgt.vx = h.dirX * sp;
                tgt.vz = h.dirZ * sp;
                if (!h.noCombo) {
                    att.vx -= h.dirX * 2.5;
                    att.vz -= h.dirZ * 2.5;
                }
                this.hitstop = Math.max(this.hitstop, h.noCombo ? 0 : 0.04);
                this.emit({ type: 'block', x: px, y: py, z: pz, target: tgt.index, attacker: att.index, strength: (0, math_js_4.clamp)(h.damage / 70, 0.3, 1.5) });
                if (!h.noCombo)
                    this.emit({ type: 'shake', amount: h.shake * 0.4 });
                return 'block';
            }
            // ---- armor (absorbs weak hits during the wind-up/active of an armoured move)
            const tAtk = tgt.attack;
            if (tgt.state === 'attack' && tAtk && tAtk.armor !== undefined &&
                tgt.attackTime < tAtk.startup + tAtk.active && h.damage <= tAtk.armor) {
                const dmg = (0, DamageSystem_js_1.computeDamage)(h.damage, att.stats.power * att.powerMul, tgt.stats.defense, 0);
                this.applyDamage(att, tgt, dmg, false);
                att.attackConnected = true;
                tgt.flash = 0.5;
                this.hitstop = Math.max(this.hitstop, 0.05);
                this.emit({ type: 'armor', x: px, y: py, z: pz, target: tgt.index });
                this.emit({ type: 'hit', x: px, y: py, z: pz, target: tgt.index, attacker: att.index, strength: 0.4, damage: dmg, heavy: false });
                return 'armor';
            }
            // ---- clean hit
            const prev = h.noCombo || h.noScale ? 0 : tgt.hitsTaken;
            const juggling = canJuggle && tgt.state === 'launched';
            const capped = !h.noCombo && tgt.hitsTaken >= exports.COMBO_HARD_CAP;
            const dmg = (0, DamageSystem_js_1.computeDamage)(h.damage, att.stats.power * att.powerMul, tgt.stats.defense, prev);
            this.applyDamage(att, tgt, dmg, !h.noCombo);
            att.attackConnected = true;
            att.energy = Math.min(att.stats.maxEnergy, att.energy + h.energyGain);
            tgt.flash = 1;
            this.interrupt(tgt);
            tgt.lastAttacker = att.index;
            const lethal = tgt.hp <= 0;
            const sp = (0, DamageSystem_js_1.knockbackSpeed)(h.knockback, tgt.stats.mass);
            tgt.vx = h.dirX * sp;
            tgt.vz = h.dirZ * sp;
            if (lethal) {
                tgt.hp = 0;
                tgt.setState('launched');
                tgt.vy = 13;
                tgt.vx = h.dirX * Math.max(sp, 12);
                tgt.vz = h.dirZ * Math.max(sp, 12);
            }
            else if (juggling || capped || h.knockdown || h.launch > 0) {
                tgt.setState('launched');
                if (juggling) {
                    // Every extra air hit lifts less, so air combos are finite and fall back to the floor.
                    tgt.vy = (0, math_js_4.clamp)(Math.max(h.launch, 10) * Math.pow(0.78, tgt.juggle), 6, 26);
                    tgt.juggle++;
                }
                else {
                    tgt.vy = h.launch > 0 ? h.launch : 9;
                    tgt.juggle = capped ? exports.JUGGLE_MAX : 0;
                }
            }
            else {
                tgt.setState('hitstun', (0, DamageSystem_js_1.scaledHitstun)(h.hitstun, prev));
            }
            this.hitstop = Math.max(this.hitstop, h.hitstop);
            this.damageProps(px, pz, 4, dmg * 0.8);
            this.emit({
                type: 'hit', x: px, y: py, z: pz, target: tgt.index, attacker: att.index,
                strength: (0, math_js_4.clamp)(dmg / 55, 0.3, 2.2), damage: dmg, heavy: h.heavy,
            });
            this.emit({ type: 'shake', amount: h.shake });
            return 'hit';
        }
        applyDamage(att, tgt, dmg, combo) {
            tgt.hp -= dmg;
            if (this.options.infiniteHp[tgt.index])
                tgt.hp = tgt.stats.maxHp;
            tgt.damageTaken += dmg;
            att.damageDealt += dmg;
            att.hitsLanded++;
            tgt.energy = Math.min(tgt.stats.maxEnergy, tgt.energy + (0, DamageSystem_js_1.energyOnTakingDamage)(dmg));
            if (combo) {
                tgt.hitsTaken++;
                tgt.comboDamage += dmg;
                tgt.comboTimer = 0.4;
                att.maxCombo = Math.max(att.maxCombo, tgt.hitsTaken);
            }
        }
        // ------------------------------------------------------------------- beams
        spawnBeam(f, ratio, override, power) {
            const def = override ?? f.def.moves.beam;
            const beam = {
                owner: f.index, def, ratio, power: power ?? 1 + ratio * 2,
                yaw: f.yaw, timeLeft: (0, math_js_4.lerp)(def.durationMin, def.durationMax, ratio), tickTimer: 0.05,
                length: def.length, drawLength: def.length,
                originX: 0, originY: 0, originZ: 0, dirX: 0, dirZ: 0, clashing: false,
            };
            this.beams.push(beam);
            this.syncBeamOrigin(beam, f);
            this.emit({ type: 'beamFire', fighter: f.index, power: beam.power });
        }
        syncBeamOrigin(beam, f) {
            beam.dirX = Math.sin(beam.yaw);
            beam.dirZ = Math.cos(beam.yaw);
            beam.originX = f.x + beam.dirX * (f.radius * 0.9);
            beam.originZ = f.z + beam.dirZ * (f.radius * 0.9);
            beam.originY = f.y + f.height * 0.62;
        }
        removeBeamOf(owner, natural) {
            const i = this.beams.findIndex((b) => b.owner === owner);
            if (i < 0)
                return;
            this.beams.splice(i, 1);
            if (this.clash && (this.clash.a.owner === owner || this.clash.b.owner === owner)) {
                this.clash.a.clashing = false;
                this.clash.b.clashing = false;
                this.clash = null;
            }
            const f = this.fighters[owner];
            const recovery = (f.ultimate?.beam ?? f.def.moves.beam).recovery;
            this.emit({ type: 'beamEnd', fighter: owner });
            if (f.ultimate)
                this.finishUltimate(f, !natural);
            if (natural && f.state === 'beam') {
                f.setState('idle');
                f.lock = recovery;
            }
        }
        /** Ends an ultimate exactly once (used by completion, interruption, KO and round resets). */
        finishUltimate(f, interrupted) {
            if (!f.ultimate)
                return;
            f.ultimate = null;
            f.ultFired = false;
            this.emit({ type: 'ultimateEnd', fighter: f.index, interrupted });
        }
        beamOf(owner) {
            return this.beams.find((b) => b.owner === owner);
        }
        updateBeams(dt) {
            for (const beam of [...this.beams]) {
                const f = this.fighters[beam.owner];
                if (f.state !== 'beam') {
                    this.removeBeamOf(beam.owner, false);
                    continue;
                }
                const opp = this.fighters[1 - beam.owner];
                beam.yaw = (0, math_js_4.turnToward)(beam.yaw, (0, HitDetection_js_2.bearing)(f, opp), beam.def.aimSpeed * dt);
                f.yaw = beam.yaw;
                this.syncBeamOrigin(beam, f);
                // Truncate at the arena edge.
                const edge = this.distanceToEdge(beam.originX, beam.originZ, beam.dirX, beam.dirZ);
                beam.length = Math.min(beam.def.length, edge);
                beam.drawLength = beam.length;
                beam.timeLeft -= dt;
            }
            (0, BeamClashSystem_js_1.detectClash)(this);
            if (this.clash)
                (0, BeamClashSystem_js_1.updateClash)(this, dt);
            for (const beam of [...this.beams]) {
                if (!this.beams.includes(beam))
                    continue;
                const f = this.fighters[beam.owner];
                if (!beam.clashing) {
                    beam.tickTimer -= dt;
                    while (beam.tickTimer <= 0) {
                        beam.tickTimer += beam.def.tickInterval;
                        this.beamTick(beam, f);
                    }
                    this.damageProps(beam.originX + beam.dirX * beam.drawLength * 0.5, beam.originZ + beam.dirZ * beam.drawLength * 0.5, beam.drawLength * 0.5, 120 * dt);
                }
                if (beam.timeLeft <= 0 && !beam.clashing)
                    this.removeBeamOf(beam.owner, true);
            }
        }
        /** True when the beam's line reaches `t` (ignores vertical when `ignoreY`). */
        beamReaches(beam, t) {
            const hit = (0, HitDetection_js_2.segmentCircle)(beam.originX, beam.originZ, beam.dirX, beam.dirZ, beam.length, t.x, t.z, beam.def.width * 0.5 + t.radius);
            if (!hit.hit)
                return false;
            return beam.originY >= t.y && beam.originY <= t.y + t.height;
        }
        beamTick(beam, f) {
            const t = this.fighters[1 - beam.owner];
            if (!this.beamReaches(beam, t))
                return;
            const seg = (0, HitDetection_js_2.segmentCircle)(beam.originX, beam.originZ, beam.dirX, beam.dirZ, beam.length, t.x, t.z, beam.def.width * 0.5 + t.radius);
            beam.drawLength = Math.max(2, Math.min(beam.length, seg.along + t.radius * 0.6));
            const d = beam.def;
            const info = {
                damage: (0, math_js_4.lerp)(d.tickDamageMin, d.tickDamageMax, beam.ratio),
                hitstun: d.hitstun, blockstun: d.hitstun, knockback: d.knockback, launch: 0, knockdown: false,
                guardDamage: d.guardDamage ?? 5, hitstop: 0, shake: 0.12, energyGain: 1.2, dirX: beam.dirX, dirZ: beam.dirZ,
                guardable: true, noScale: false, counterable: false, noCombo: true, heavy: false,
            };
            this.deliver(f, t, info, t.x - beam.dirX * t.radius, beam.originY, t.z - beam.dirZ * t.radius);
            // beams can drain a tick even through hitstun states; keep the victim pinned briefly
            if (t.state === 'hitstun')
                t.stateTimer = Math.max(t.stateTimer, d.hitstun);
        }
        distanceToEdge(ox, oz, dx, dz) {
            // Ray vs circle of radius R centred at origin; origin is inside.
            const b = ox * dx + oz * dz;
            const c = ox * ox + oz * oz - this.radius * this.radius;
            const disc = b * b - c;
            if (disc <= 0)
                return 0;
            return Math.max(0, -b + Math.sqrt(disc));
        }
        /** Used by clash resolution to apply a heavy finishing hit. */
        clashHit(winner, loser, beamDef, power) {
            const dirX = loser.x - winner.x;
            const dirZ = loser.z - winner.z;
            const len = Math.hypot(dirX, dirZ) || 1;
            const info = {
                damage: beamDef.tickDamageMax * 14 * (0.6 + power * 0.2), hitstun: 0.6, blockstun: 0.4,
                knockback: 24, launch: 14, knockdown: true, guardDamage: 60, hitstop: 0.18, shake: 0.9,
                energyGain: 0, dirX: dirX / len, dirZ: dirZ / len, guardable: false, noScale: false, counterable: false, noCombo: true, heavy: true,
            };
            // A beam clash loss ignores dodge frames and guards: the loser is overwhelmed.
            loser.invuln = 0;
            this.deliver(winner, loser, info, loser.x, loser.y + loser.height * 0.6, loser.z);
        }
        colorOf(owner) {
            return this.fighters[owner].def.moves.beam.color;
        }
    }
    exports.Battle = Battle;
});
define("ai/CharacterAI", ["require", "exports", "combat/HitDetection", "combat/types", "math", "characters/TransformationSystem", "combat/FighterController"], function (require, exports, HitDetection_js_3, types_js_2, math_js_5, TransformationSystem_js_3, FighterController_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CharacterAI = void 0;
    const DIFFICULTY = {
        easy: { reaction: 0.48, guardChance: 0.22, dodgeChance: 0.1, chain: 0.3, punish: 0.25, perfectGuard: 0, tech: 0.1, mash: 3, chargeSkill: 0.25, tempo: 0.6, reserve: 10, ult: 0.08, ultSave: false },
        normal: { reaction: 0.28, guardChance: 0.45, dodgeChance: 0.25, chain: 0.6, punish: 0.55, perfectGuard: 0.1, tech: 0.4, mash: 5.5, chargeSkill: 0.6, tempo: 1, reserve: 25, ult: 0.16, ultSave: false },
        hard: { reaction: 0.15, guardChance: 0.62, dodgeChance: 0.38, chain: 0.85, punish: 0.85, perfectGuard: 0.35, tech: 0.7, mash: 8.5, chargeSkill: 0.95, tempo: 1.2, reserve: 40, ult: 0.3, ultSave: true },
    };
    /**
     * Computer opponent. It produces the same `InputFrame` a human would, and it only reacts to a delayed
     * snapshot of the opponent (what has been visible on screen for `reaction` seconds) - it never reads inputs.
     */
    class CharacterAI {
        battle;
        index;
        difficulty;
        mode;
        rng;
        clock = 0;
        history = [];
        thinkTimer = 0;
        moveX = 0;
        moveY = 0;
        strafeUntil = 0;
        guardUntil = 0;
        guardPressAt = 0;
        dodgeAt = -1;
        jumpAt = -1;
        lastUltAt = -99;
        dodgeMoveX = 0;
        dodgeMoveY = -1;
        lastObsKey = '';
        reactedKey = '';
        seenProjectiles = new Map();
        beamSeenAt = -1;
        plannedCharge = 0;
        mashTimer = 0;
        techPressAt = -1;
        grabSeen = false;
        chainAttack = null;
        chainWanted = false;
        lastAttackStart = 0;
        opponentGuardTime = 0;
        dummyTimer = 0;
        constructor(battle, index, difficulty = 'normal', mode = 'normal', seed = 99) {
            this.battle = battle;
            this.index = index;
            this.difficulty = difficulty;
            this.mode = mode;
            this.rng = new math_js_5.Rng(seed + index * 7919);
        }
        get p() {
            return DIFFICULTY[this.difficulty];
        }
        update(dt) {
            this.clock += dt;
            const b = this.battle;
            const me = b.fighters[this.index];
            const opp = b.fighters[1 - this.index];
            this.record(opp);
            const inp = (0, types_js_2.emptyInput)();
            if (!b.controlsEnabled || !me.alive)
                return inp;
            if (opp.state === 'guard')
                this.opponentGuardTime += dt;
            else
                this.opponentGuardTime = Math.max(0, this.opponentGuardTime - dt * 2);
            if (this.mode !== 'normal')
                return this.dummy(dt, me, opp, inp);
            const obs = this.observed();
            const g = (0, HitDetection_js_3.gap)(me, opp);
            // --- beam clash: mash at a difficulty-dependent rate
            if (b.clash) {
                this.mashTimer -= dt;
                if (this.mashTimer <= 0) {
                    inp.pressed.beam = true;
                    this.mashTimer = (1 / this.p.mash) * this.rng.range(0.8, 1.25);
                }
                return inp;
            }
            // --- being thrown: maybe tech
            if (me.state === 'grabbed') {
                if (!this.grabSeen) {
                    this.grabSeen = true;
                    this.techPressAt = this.rng.chance(this.p.tech) ? this.clock + this.p.reaction * 0.7 : -1;
                }
                if (this.techPressAt >= 0 && this.clock >= this.techPressAt && me.techWindow > 0) {
                    inp.pressed.grab = true;
                    this.techPressAt = -1;
                }
                return inp;
            }
            this.grabSeen = false;
            // --- charging a beam: hold until the planned charge, then release
            if (me.state === 'charge') {
                inp.held.beam = me.chargeTime < this.plannedCharge;
                return inp;
            }
            // --- mid-attack: follow-up logic only
            if (me.state === 'attack' && me.attack) {
                if (this.chainAttack !== me.attack) {
                    this.chainAttack = me.attack;
                    this.chainWanted = this.rng.chance(this.p.chain);
                }
                const a = me.attack;
                if (this.chainWanted && me.attackConnected && a.cancelAt !== undefined && me.attackTime >= a.cancelAt) {
                    const m = me.def.moves;
                    const idx = m.lights.indexOf(a);
                    if (idx >= 0 && idx + 1 < m.lights.length)
                        inp.pressed.light = true;
                    else if (idx >= 0 && this.rng.chance(0.5))
                        inp.pressed.heavy = true;
                    else if (me.energy >= m.special.energyCost + this.p.reserve && me.specialCooldown <= 0)
                        inp.pressed.special = true;
                    this.chainWanted = false;
                }
                return inp;
            }
            this.watchThreats(me, opp, g);
            if (!me.neutral)
                return inp;
            // --- scheduled dodge
            if (this.dodgeAt >= 0 && this.clock >= this.dodgeAt) {
                this.dodgeAt = -1;
                inp.pressed.dodge = true;
                inp.moveX = this.dodgeMoveX;
                inp.moveY = this.dodgeMoveY;
                return inp;
            }
            // --- scheduled jump (timed to clear a ground shockwave)
            if (this.jumpAt >= 0 && this.clock >= this.jumpAt) {
                this.jumpAt = -1;
                if (me.grounded)
                    inp.pressed.jump = true;
                return inp;
            }
            // --- guard hold
            if (this.clock < this.guardUntil) {
                if (this.clock >= this.guardPressAt)
                    inp.held.guard = true;
                return inp;
            }
            // --- reactions to the (delayed) opponent
            if (this.react(obs, me, opp, g, inp))
                return inp;
            // --- movement + decisions every think tick
            this.thinkTimer -= dt;
            if (this.thinkTimer <= 0) {
                this.thinkTimer = this.rng.range(0.08, 0.2);
                if (this.decide(me, opp, g, inp))
                    return inp;
            }
            inp.moveX = this.clock < this.strafeUntil ? this.moveX : this.moveX * 0.5;
            inp.moveY = this.moveY;
            return inp;
        }
        // ------------------------------------------------------------ observation
        record(opp) {
            this.history.push({ t: this.clock, state: opp.state, atk: opp.attack, attackTime: opp.attackTime, chargeTime: opp.chargeTime });
            const cutoff = this.clock - 1.2;
            while (this.history.length > 2 && this.history[1].t < cutoff)
                this.history.shift();
        }
        /** What the opponent was doing `reaction` seconds ago. */
        observed() {
            const target = this.clock - this.p.reaction;
            let pick = this.history[0];
            for (const s of this.history) {
                if (s.t <= target)
                    pick = s;
                else
                    break;
            }
            return pick;
        }
        // ------------------------------------------------------------- threat reactions
        watchThreats(me, opp, _g) {
            const b = this.battle;
            // projectiles inbound
            for (const pr of b.projectiles) {
                if (pr.owner === this.index)
                    continue;
                if (!this.seenProjectiles.has(pr.id))
                    this.seenProjectiles.set(pr.id, this.clock);
                const seen = this.seenProjectiles.get(pr.id);
                if (this.clock - seen < this.p.reaction || this.clock - seen > this.p.reaction + 0.15)
                    continue;
                const dx = me.x - pr.x;
                const dz = me.z - pr.z;
                const dist = Math.hypot(dx, dz);
                const closing = (pr.vx * dx + pr.vz * dz) / (dist || 1);
                if (closing <= 0 || dist / closing > 0.7)
                    continue;
                const roll = this.rng.next();
                if (roll < this.p.guardChance) {
                    this.guardUntil = this.clock + dist / closing + 0.3;
                    this.guardPressAt = this.clock;
                }
                else if (roll < this.p.guardChance + this.p.dodgeChance) {
                    this.scheduleDodge(me, opp, Math.max(0, dist / closing - 0.12));
                }
            }
            if (this.seenProjectiles.size > 20) {
                for (const id of [...this.seenProjectiles.keys()]) {
                    if (!b.projectiles.some((p) => p.id === id))
                        this.seenProjectiles.delete(id);
                }
            }
            // beam on its way
            const beam = b.beamOf(opp.index);
            if (beam) {
                if (this.beamSeenAt < 0)
                    this.beamSeenAt = this.clock;
                if (this.clock - this.beamSeenAt >= this.p.reaction && b.beamReaches(beam, me) && !b.clash) {
                    if (this.rng.chance(0.5 + 0.5 * this.p.perfectGuard + 0.2) && me.energy >= me.def.moves.beam.energyCost && me.state !== 'charge' && me.beamCooldown <= 0 && this.clock - this.beamSeenAt < this.p.reaction + 0.12) {
                        // Answer with a quick counter-beam when we can afford it (leads to a clash).
                        this.plannedCharge = me.def.moves.beam.minCharge + 0.05;
                        this.pendingBeam = true;
                    }
                    else {
                        this.strafeOutOfBeam(me, beam.dirX, beam.dirZ);
                        this.beamSeenAt = this.clock + 0.4;
                    }
                }
            }
            else {
                this.beamSeenAt = -1;
            }
        }
        pendingBeam = false;
        lastBackstep = -10;
        strafeOutOfBeam(me, dirX, dirZ) {
            // Which side of the beam line are we on? Strafe further to that side.
            const rightX = -me.forwardZ;
            const rightZ = me.forwardX;
            const side = Math.sign(rightX * -dirZ + rightZ * dirX) || (this.rng.chance(0.5) ? 1 : -1);
            this.moveX = side;
            this.moveY = 0;
            this.strafeUntil = this.clock + 0.7;
        }
        scheduleDodge(me, opp, delay) {
            if (me.dodgeCooldown > 0)
                return;
            this.dodgeAt = this.clock + delay;
            const side = this.rng.chance(0.5) ? 1 : -1;
            this.dodgeMoveX = side;
            this.dodgeMoveY = 0;
            void opp;
        }
        /** Returns true if it consumed the tick. */
        react(obs, me, opp, g, inp) {
            if (this.pendingBeam) {
                this.pendingBeam = false;
                inp.pressed.beam = true;
                return true;
            }
            const a = obs.atk;
            const attacking = obs.state === 'attack' && a;
            const key = attacking ? `${a.id}@${(this.clock - obs.attackTime).toFixed(2)}` : '';
            const phase = attacking ? (obs.attackTime < a.startup ? 'startup' : obs.attackTime < a.startup + a.active ? 'active' : 'recovery') : 'none';
            // ---- defend against a fresh attack
            if (attacking && (phase === 'startup' || phase === 'active') && key !== this.lastObsKey) {
                this.lastObsKey = key;
                const threatens = a.type === 'aoe' ? g <= (a.radius ?? 12)
                    : a.lungeSpeed ? g <= a.reach + 2.5 + a.lungeSpeed * (a.lungeTime ?? 0.3)
                        : g <= a.reach + 2.5;
                if (threatens) {
                    const remaining = a.startup - (obs.attackTime + this.p.reaction);
                    const roll = this.rng.next();
                    if (a.type === 'throw') {
                        if (roll < this.p.dodgeChance * 1.6) {
                            this.scheduleDodge(me, opp, Math.max(0, remaining - 0.1));
                        }
                        else if (roll < 0.6 && me.attackPhase === 'none') {
                            inp.pressed.light = true;
                            return true;
                        }
                    }
                    else if (a.type === 'aoe') {
                        // Ground shockwaves pass under a jump: take off so that we are airborne exactly when it goes off.
                        if (roll < 0.5 + this.p.dodgeChance && me.grounded) {
                            this.jumpAt = this.clock + Math.max(0, remaining - 0.35);
                        }
                    }
                    else if (a.guardable === false) {
                        // Unblockable rush: guarding is useless, so sidestep it as it starts.
                        if (roll < Math.min(0.9, this.p.dodgeChance * 1.8 + 0.15)) {
                            this.scheduleDodge(me, opp, Math.max(0, remaining - 0.05));
                        }
                    }
                    else if (roll < this.p.guardChance + this.caution(me)) {
                        const perfect = this.rng.chance(this.p.perfectGuard) && remaining > 0.08;
                        this.guardPressAt = this.clock + (perfect ? Math.max(0, remaining - 0.08) : 0);
                        this.guardUntil = this.clock + Math.max(0.3, remaining + a.active + 0.2);
                        return false;
                    }
                    else if (roll < this.p.guardChance + this.caution(me) + this.p.dodgeChance) {
                        this.scheduleDodge(me, opp, Math.max(0, remaining - 0.1));
                    }
                }
            }
            // ---- punish an unsafe move (observed recovery)
            if (attacking && phase === 'recovery' && g <= 9 && key !== this.reactedKey) {
                const recoveryLeft = a.startup + a.active + a.recovery - (obs.attackTime + this.p.reaction);
                if (recoveryLeft > 0.12) {
                    this.reactedKey = key;
                    if (this.rng.chance(this.p.punish)) {
                        const m = me.def.moves;
                        if (g <= m.heavy.reach - 1)
                            inp.pressed.heavy = true;
                        else
                            inp.pressed.light = true;
                        return true;
                    }
                }
            }
            // ---- rush down a beam ultimate that is still charging (its armour breaks against a heavy hit)
            if (attacking && a.type === 'beam' && phase === 'startup' && g < 32 && this.rng.chance(0.5 + this.p.punish * 0.4)) {
                this.moveY = 1;
                this.moveX = 0;
                this.strafeUntil = this.clock;
                if (g <= me.def.moves.heavy.reach - 1) {
                    inp.pressed.heavy = true;
                    return true;
                }
            }
            // ---- rush down a charging beam that has not been fired yet
            if (obs.state === 'charge' && obs.chargeTime > 0.25 && g < 16) {
                this.moveY = 1;
                this.moveX = 0;
                this.strafeUntil = this.clock;
                if (g <= me.def.moves.lights[0].reach - 1) {
                    inp.pressed.light = true;
                    return true;
                }
            }
            return false;
        }
        // -------------------------------------------------------------- decisions
        decide(me, opp, g, inp) {
            const prof = me.def.ai;
            const m = me.def.moves;
            const lowHp = me.hp / me.stats.maxHp < 0.25;
            const pref = prof.preferredRange + (lowHp ? 2 : 0);
            // Ranged fighters live off their projectiles, so they hold far less energy back than melee fighters do.
            const ranged = me.def.archetype === 'ranged';
            const reserve = ranged ? Math.min(this.p.reserve, 6) : this.p.reserve;
            const tempo = this.p.tempo * (0.5 + prof.aggression) * (lowHp ? 0.7 : 1);
            // Opponent is a sitting duck (down / stunned / recovering): go for it.
            const vulnerable = opp.state === 'hitstun' || opp.state === 'blockstun' || opp.state === 'down' || opp.state === 'getup';
            // Ultimate: committed and telegraphed, so only fire it when it is likely to connect.
            const ult = me.def.moves.ultimate;
            if ((0, FighterController_js_2.canUltimate)(me) && this.clock - this.lastUltAt > 4 && this.rng.chance(this.p.ult * tempo)) {
                const k = ult.kind;
                const fits = k === 'beam' ? g > 6 && g < 50 && !opp.untouchable
                    : k === 'projectile' ? g > 10 && g < 45 && !opp.untouchable
                        : k === 'shockwave' ? g <= (ult.attack.radius ?? 20) - 4 && opp.grounded
                            : g > 3 && g < 16 && opp.grounded;
                if (fits) {
                    this.lastUltAt = this.clock;
                    inp.pressed.ultimate = true;
                    return true;
                }
            }
            // Harder AIs hold their energy when an ultimate is close instead of spending it on small moves.
            const saving = this.p.ultSave && me.energy < ult.energyCost && me.energy >= ult.energyCost - 30;
            // Transform at a safe distance (the change leaves the fighter open for a moment).
            if (me.baseDef.forms && (0, TransformationSystem_js_3.canTransform)(me) && g > 12 && !opp.untouchable) {
                const next = (0, TransformationSystem_js_3.nextFormIndex)(me.baseDef, me.formIndex);
                const cost = next >= 0 ? me.baseDef.forms[next].energyCost : 0;
                const entering = next >= 0 && me.formIndex < 0 && me.energy >= cost + reserve + 10;
                const leaving = next < 0 && me.form !== null && me.form.duration === 0 && this.rng.chance(0.3);
                if ((entering || leaving) && this.rng.chance(0.2 * tempo)) {
                    inp.pressed.alt = true;
                    return true;
                }
            }
            // Long range: projectile / beam
            if (g > (ranged ? 6 : 9) && g < 50 && !opp.untouchable) {
                const wantsBeam = !saving && me.energy >= m.beam.energyCost + reserve * 0.5 && me.beamCooldown <= 0 && this.rng.chance(prof.beamLove * 0.28 * tempo);
                if (wantsBeam) {
                    this.plannedCharge = m.beam.minCharge + (m.beam.maxCharge - m.beam.minCharge) * this.p.chargeSkill * this.rng.range(0.1, 1);
                    inp.pressed.beam = true;
                    return true;
                }
                if (!saving && m.special.type === 'projectile' && me.energy >= m.special.energyCost + reserve && me.specialCooldown <= 0 && this.rng.chance(0.25 * tempo)) {
                    inp.pressed.special = true;
                    return true;
                }
            }
            // Ranged fighters make space: back-step out of melee (the neutral dodge is a back-step), then shoot.
            if (ranged && g < 6.5 && !vulnerable && me.grounded && me.dodgeCooldown <= 0 && this.clock - this.lastBackstep > 0.9
                && opp.attackPhase !== 'active' && this.rng.chance(0.35 + 0.2 * prof.caution)) {
                this.lastBackstep = this.clock;
                inp.pressed.dodge = true;
                inp.moveY = -1;
                return true;
            }
            // In melee range: choose a move
            const lightReach = m.lights[0].reach - 0.5;
            const inRange = g <= lightReach;
            if (inRange && (this.clock - this.lastAttackStart > 0.25)) {
                const attackChance = (vulnerable ? 0.9 : 0.35) * tempo;
                if (this.rng.chance(attackChance)) {
                    this.lastAttackStart = this.clock;
                    const w = [
                        [3, 'light'],
                        [vulnerable ? 2 : 1.1, 'heavy'],
                        [0.6, 'heavyF'],
                        [this.opponentGuardTime > 0.5 ? 3 : 0.4, 'grab'],
                    ];
                    if (m.special.type === 'aoe' && g <= (m.special.radius ?? 12) - 3 && me.energy >= m.special.energyCost + reserve && me.specialCooldown <= 0)
                        w.push([2, 'special']);
                    if (m.special.type === 'melee' && g <= m.special.reach && me.energy >= m.special.energyCost + reserve && me.specialCooldown <= 0)
                        w.push([1.5, 'special']);
                    let total = 0;
                    for (const [wt] of w)
                        total += wt;
                    let r = this.rng.next() * total;
                    let pick = w[0][1];
                    for (const [wt, k] of w) {
                        r -= wt;
                        if (r <= 0) {
                            pick = k;
                            break;
                        }
                    }
                    if (pick === 'light')
                        inp.pressed.light = true;
                    else if (pick === 'heavy')
                        inp.pressed.heavy = true;
                    else if (pick === 'heavyF') {
                        inp.pressed.heavy = true;
                        inp.moveY = 1;
                    }
                    else if (pick === 'grab')
                        inp.pressed.grab = true;
                    else
                        inp.pressed.special = true;
                    return true;
                }
            }
            // Gap closers for specials with a lunge (speed hero)
            if (m.special.lungeSpeed && g > 8 && g < 22 && me.energy >= m.special.energyCost + reserve && me.specialCooldown <= 0 && this.rng.chance(0.2 * tempo)) {
                inp.pressed.special = true;
                return true;
            }
            // Spacing
            if (g > pref + 2.5) {
                this.moveY = 1;
                this.moveX = this.rng.chance(0.3) ? (this.rng.chance(0.5) ? 1 : -1) * 0.5 : 0;
            }
            else if (g < pref - 2 && !vulnerable) {
                this.moveY = lowHp || ranged || this.rng.chance(0.4) ? -0.6 : 0;
                this.moveX = this.rng.chance(0.5) ? 1 : -1;
            }
            else {
                this.moveY = vulnerable ? 1 : this.rng.chance(0.5) ? 0.4 : 0;
                this.moveX = this.rng.chance(0.4) ? (this.rng.chance(0.5) ? 1 : -1) : 0;
            }
            this.strafeUntil = this.clock + this.rng.range(0.15, 0.5);
            // Occasionally hop to avoid low sweeps / pressure
            if (inRange && opp.attackPhase === 'startup' && opp.attack && opp.attack.yHigh < 0.5 && this.rng.chance(this.p.dodgeChance) && me.grounded) {
                inp.pressed.jump = true;
                return true;
            }
            return false;
        }
        /** Personality + health driven extra tendency to guard. */
        caution(me) {
            const lowHp = me.hp / me.stats.maxHp < 0.25 ? 0.15 : 0;
            return (me.def.ai.caution - 0.4) * 0.5 + lowHp;
        }
        // --------------------------------------------------------- practice dummies
        dummy(dt, me, opp, inp) {
            const obs = this.observed();
            const g = (0, HitDetection_js_3.gap)(me, opp);
            switch (this.mode) {
                case 'guard':
                    if (me.neutral)
                        inp.held.guard = true;
                    break;
                case 'attack': {
                    this.dummyTimer -= dt;
                    if (me.neutral) {
                        if (g > me.def.moves.lights[0].reach - 1)
                            inp.moveY = 1;
                        else if (this.dummyTimer <= 0) {
                            this.dummyTimer = 1.4;
                            inp.pressed.light = true;
                        }
                    }
                    if (me.state === 'attack' && me.attack && me.attackConnected && me.attackTime >= (me.attack.cancelAt ?? 99))
                        inp.pressed.light = true;
                    break;
                }
                case 'dodge':
                    if (me.neutral && obs.state === 'attack' && obs.atk && g < obs.atk.reach + 3 && obs.attackTime < obs.atk.startup + 0.05 && me.dodgeCooldown <= 0) {
                        inp.pressed.dodge = true;
                        inp.moveX = this.rng.chance(0.5) ? 1 : -1;
                    }
                    break;
                default:
                    break;
            }
            return inp;
        }
    }
    exports.CharacterAI = CharacterAI;
});
define("audio/AudioManager", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.AudioManager = void 0;
    /**
     * Fully procedural audio (Web Audio): no asset files, so the game is playable when audio is missing, blocked or
     * not yet unlocked by a user gesture. Every call is wrapped so audio can never break gameplay.
     */
    class AudioManager {
        ctx = null;
        master = null;
        sfxBus = null;
        musicBus = null;
        noise = null;
        voices = 0;
        lastPlayed = new Map();
        beamNodes = null;
        musicTimer = null;
        musicStep = 0;
        musicOn = false;
        vol = { master: 0.8, music: 0.5, sfx: 0.9 };
        /** True once a context exists and is running. */
        unlocked = false;
        failed = false;
        setVolumes(master, music, sfx) {
            this.vol = { master, music, sfx };
            if (this.master)
                this.master.gain.value = master;
            if (this.sfxBus)
                this.sfxBus.gain.value = sfx;
            if (this.musicBus)
                this.musicBus.gain.value = music * 0.35;
        }
        /** Must be called from a user gesture handler (click / key / touch). */
        unlock() {
            if (this.failed)
                return;
            try {
                if (!this.ctx) {
                    const Ctor = window.AudioContext ?? window.webkitAudioContext;
                    if (!Ctor) {
                        this.failed = true;
                        return;
                    }
                    this.ctx = new Ctor();
                    this.master = this.ctx.createGain();
                    this.sfxBus = this.ctx.createGain();
                    this.musicBus = this.ctx.createGain();
                    const comp = this.ctx.createDynamicsCompressor();
                    this.sfxBus.connect(this.master);
                    this.musicBus.connect(this.master);
                    this.master.connect(comp);
                    comp.connect(this.ctx.destination);
                    const len = this.ctx.sampleRate;
                    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
                    const d = this.noise.getChannelData(0);
                    for (let i = 0; i < len; i++)
                        d[i] = Math.random() * 2 - 1;
                    this.setVolumes(this.vol.master, this.vol.music, this.vol.sfx);
                }
                if (this.ctx.state === 'suspended')
                    void this.ctx.resume();
                this.unlocked = true;
                if (this.musicOn && this.musicTimer === null)
                    this.startMusicLoop();
            }
            catch {
                this.failed = true;
            }
        }
        suspend() {
            try {
                void this.ctx?.suspend();
            }
            catch { /* ignore */ }
        }
        resume() {
            try {
                if (this.ctx && this.unlocked)
                    void this.ctx.resume();
            }
            catch { /* ignore */ }
        }
        ready(minGap = 0.03, key = '') {
            if (!this.ctx || !this.sfxBus || this.ctx.state !== 'running')
                return false;
            if (this.voices > 28)
                return false;
            if (key) {
                const t = this.ctx.currentTime;
                const last = this.lastPlayed.get(key) ?? -1;
                if (t - last < minGap)
                    return false;
                this.lastPlayed.set(key, t);
            }
            return true;
        }
        tone(freq, freqEnd, dur, type, gain, delay = 0, bus) {
            const ctx = this.ctx;
            const out = bus ?? this.sfxBus;
            if (!ctx || !out)
                return;
            const t0 = ctx.currentTime + delay;
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t0);
            osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.01, dur * 0.2));
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            osc.connect(g);
            g.connect(out);
            this.voices++;
            osc.onended = () => { this.voices--; };
            osc.start(t0);
            osc.stop(t0 + dur + 0.02);
        }
        burst(dur, filterType, f0, f1, gain, delay = 0, q = 0.8) {
            const ctx = this.ctx;
            if (!ctx || !this.sfxBus || !this.noise)
                return;
            const t0 = ctx.currentTime + delay;
            const src = ctx.createBufferSource();
            src.buffer = this.noise;
            src.loop = true;
            const filt = ctx.createBiquadFilter();
            filt.type = filterType;
            filt.Q.value = q;
            filt.frequency.setValueAtTime(f0, t0);
            filt.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(gain, t0 + Math.min(0.008, dur * 0.2));
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
            src.connect(filt);
            filt.connect(g);
            g.connect(this.sfxBus);
            this.voices++;
            src.onended = () => { this.voices--; };
            src.start(t0, Math.random() * 0.5);
            src.stop(t0 + dur + 0.02);
        }
        play(name, strength = 1) {
            try {
                this.playInner(name, strength);
            }
            catch {
                this.failed = true;
            }
        }
        playInner(name, k) {
            if (!this.ready(name === 'hitL' || name === 'hitH' ? 0.045 : 0.03, name))
                return;
            switch (name) {
                case 'ui':
                    this.tone(660, 880, 0.07, 'square', 0.12);
                    break;
                case 'uiBack':
                    this.tone(520, 330, 0.09, 'square', 0.1);
                    break;
                case 'swingL':
                    this.burst(0.14, 'bandpass', 700, 2200, 0.22, 0, 1.2);
                    break;
                case 'swingH':
                    this.burst(0.26, 'bandpass', 300, 1500, 0.35, 0, 1);
                    this.tone(110, 60, 0.2, 'sawtooth', 0.08);
                    break;
                case 'hitL':
                    this.burst(0.12, 'lowpass', 2600, 400, 0.5 * k);
                    this.tone(190, 70, 0.14, 'triangle', 0.45 * k);
                    break;
                case 'hitH':
                    this.burst(0.35, 'lowpass', 1800, 120, 0.8);
                    this.tone(120, 38, 0.4, 'sine', 0.9);
                    this.tone(260, 90, 0.18, 'sawtooth', 0.22);
                    break;
                case 'block':
                    this.burst(0.09, 'highpass', 2500, 5000, 0.3);
                    this.tone(900, 600, 0.1, 'square', 0.1);
                    break;
                case 'guardbreak':
                    this.burst(0.4, 'bandpass', 3000, 400, 0.6);
                    this.tone(500, 90, 0.35, 'sawtooth', 0.3);
                    break;
                case 'counter':
                    this.tone(1200, 1800, 0.18, 'triangle', 0.3);
                    this.tone(1800, 2400, 0.2, 'triangle', 0.2, 0.05);
                    this.burst(0.15, 'highpass', 3000, 6000, 0.3);
                    break;
                case 'armor':
                    this.tone(300, 200, 0.12, 'square', 0.18);
                    this.burst(0.08, 'bandpass', 1800, 900, 0.25);
                    break;
                case 'dodge':
                    this.burst(0.2, 'bandpass', 1800, 500, 0.2, 0, 0.7);
                    break;
                case 'jump':
                    this.tone(160, 320, 0.16, 'triangle', 0.18);
                    break;
                case 'land':
                    this.tone(90, 35, 0.3, 'sine', 0.55 * Math.min(1.5, k));
                    this.burst(0.25, 'lowpass', 700, 120, 0.45 * Math.min(1.5, k));
                    break;
                case 'stomp':
                    this.tone(70, 28, 0.6, 'sine', 0.9);
                    this.burst(0.55, 'lowpass', 900, 80, 0.7);
                    break;
                case 'throw':
                    this.tone(130, 40, 0.5, 'sine', 0.9);
                    this.burst(0.4, 'lowpass', 1200, 100, 0.6);
                    break;
                case 'projectile':
                    this.tone(500, 1400, 0.25, 'sawtooth', 0.16);
                    this.burst(0.2, 'bandpass', 1500, 3500, 0.2);
                    break;
                case 'projectileHit':
                    this.burst(0.3, 'bandpass', 2500, 300, 0.6);
                    this.tone(300, 80, 0.25, 'sawtooth', 0.3);
                    break;
                case 'charge':
                    this.tone(140, 520, 0.7, 'sawtooth', 0.11);
                    break;
                case 'beamFire':
                    this.burst(0.5, 'bandpass', 600, 2500, 0.35);
                    this.tone(220, 880, 0.35, 'sawtooth', 0.22);
                    break;
                case 'explosion':
                    this.burst(0.9, 'lowpass', 1400, 60, 1);
                    this.tone(70, 25, 0.9, 'sine', 1);
                    break;
                case 'clash':
                    this.burst(0.5, 'bandpass', 4000, 800, 0.5);
                    this.tone(880, 220, 0.5, 'square', 0.18);
                    break;
                case 'ko':
                    this.tone(260, 40, 1.1, 'sawtooth', 0.4);
                    this.burst(0.9, 'lowpass', 1600, 60, 0.9);
                    break;
                case 'victory':
                    [523, 659, 784, 1047].forEach((f, i) => this.tone(f, f, 0.35, 'triangle', 0.25, i * 0.13));
                    break;
                case 'defeat':
                    [392, 330, 262, 196].forEach((f, i) => this.tone(f, f * 0.98, 0.4, 'triangle', 0.25, i * 0.18));
                    break;
                case 'bell':
                    this.tone(880, 880, 0.5, 'sine', 0.3);
                    this.tone(1320, 1320, 0.4, 'sine', 0.12);
                    break;
                // For 'transform' the strength argument is a PITCH multiplier so every form sounds different.
                case 'transform':
                    [392, 523, 659, 988].forEach((f, i) => this.tone(f * k, f * k * 1.02, 0.4, 'sawtooth', 0.12, i * 0.07));
                    this.burst(0.5, 'highpass', 1500, 6000, 0.35);
                    this.tone(80 * k, 40 * k, 0.6, 'sine', 0.6);
                    break;
                case 'ultReady':
                    this.tone(880, 1320, 0.18, 'triangle', 0.2);
                    this.tone(1320, 1760, 0.25, 'sine', 0.14, 0.08);
                    break;
                case 'ultCharge':
                    this.tone(110, 660, 1.0, 'sawtooth', 0.1);
                    this.tone(55, 220, 1.0, 'sine', 0.35);
                    this.burst(1.0, 'bandpass', 300, 3000, 0.16);
                    break;
                case 'ultBeam':
                    this.burst(0.9, 'bandpass', 500, 3500, 0.5);
                    this.tone(180, 1100, 0.5, 'sawtooth', 0.28);
                    this.tone(60, 40, 0.8, 'sine', 0.8);
                    break;
                case 'ultQuake':
                    this.tone(60, 24, 1.2, 'sine', 1);
                    this.burst(1.1, 'lowpass', 1000, 60, 0.9);
                    this.burst(0.5, 'bandpass', 200, 80, 0.6, 0.12);
                    break;
                case 'ultStrike':
                    for (let i = 0; i < 6; i++)
                        this.burst(0.1, 'bandpass', 1500 + i * 200, 600, 0.3, i * 0.06, 1.5);
                    this.tone(300, 1500, 0.3, 'square', 0.1);
                    break;
                case 'ultNova':
                    this.tone(90, 900, 0.6, 'sawtooth', 0.22);
                    this.burst(0.8, 'lowpass', 2500, 200, 0.7);
                    this.tone(50, 30, 0.9, 'sine', 0.8);
                    break;
                case 'ultBreak':
                    this.burst(0.4, 'bandpass', 2500, 300, 0.6);
                    this.tone(500, 60, 0.4, 'sawtooth', 0.3);
                    break;
                case 'perfect':
                    this.tone(1500, 2400, 0.12, 'triangle', 0.2);
                    this.burst(0.15, 'highpass', 4000, 8000, 0.22);
                    break;
                case 'deny':
                    this.tone(220, 160, 0.14, 'square', 0.12);
                    break;
                case 'prop':
                    this.burst(0.5, 'lowpass', 1200, 150, 0.45);
                    this.tone(110, 50, 0.3, 'sawtooth', 0.15);
                    break;
            }
        }
        /** Continuous beam hum while any beam is out. `power` 0 stops it. */
        beamLoop(power) {
            try {
                const ctx = this.ctx;
                if (!ctx || !this.sfxBus || ctx.state !== 'running')
                    return;
                if (power <= 0) {
                    if (this.beamNodes) {
                        const { osc, gain } = this.beamNodes;
                        gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
                        osc.forEach((o) => o.stop(ctx.currentTime + 0.3));
                        this.beamNodes = null;
                    }
                    return;
                }
                if (!this.beamNodes) {
                    const gain = ctx.createGain();
                    gain.gain.value = 0.0001;
                    gain.connect(this.sfxBus);
                    const o1 = ctx.createOscillator();
                    const o2 = ctx.createOscillator();
                    o1.type = 'sawtooth';
                    o2.type = 'square';
                    o1.frequency.value = 95;
                    o2.frequency.value = 142;
                    o1.connect(gain);
                    o2.connect(gain);
                    o1.start();
                    o2.start();
                    this.beamNodes = { osc: [o1, o2], gain };
                }
                this.beamNodes.gain.gain.setTargetAtTime(0.05 + 0.04 * power, ctx.currentTime, 0.05);
                this.beamNodes.osc[0].frequency.setTargetAtTime(90 + power * 25, ctx.currentTime, 0.1);
            }
            catch { /* ignore */ }
        }
        // ---------------------------------------------------------------- music
        /** Simple procedural battle loop. Volume 0 (settings) silences it. */
        startMusic() {
            this.musicOn = true;
            if (this.unlocked && this.musicTimer === null)
                this.startMusicLoop();
        }
        stopMusic() {
            this.musicOn = false;
            if (this.musicTimer !== null) {
                window.clearInterval(this.musicTimer);
                this.musicTimer = null;
            }
        }
        startMusicLoop() {
            const notes = [110, 110, 165, 110, 147, 110, 165, 196];
            this.musicTimer = window.setInterval(() => {
                try {
                    const ctx = this.ctx;
                    if (!ctx || ctx.state !== 'running' || !this.musicBus || this.vol.music <= 0.01)
                        return;
                    const n = notes[this.musicStep % notes.length];
                    this.tone(n, n * 0.99, 0.28, 'sawtooth', 0.25, 0, this.musicBus);
                    if (this.musicStep % 4 === 0)
                        this.tone(55, 40, 0.4, 'sine', 0.5, 0, this.musicBus);
                    if (this.musicStep % 2 === 1)
                        this.tone(n * 4, n * 4, 0.08, 'square', 0.05, 0, this.musicBus);
                    this.musicStep++;
                }
                catch { /* ignore */ }
            }, 260);
        }
        dispose() {
            this.stopMusic();
            this.beamLoop(0);
            try {
                void this.ctx?.close();
            }
            catch { /* ignore */ }
            this.ctx = null;
        }
    }
    exports.AudioManager = AudioManager;
});
define("data/moves", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.makeAttack = makeAttack;
    /** Fills in sensible defaults so character files only describe what makes a move special. */
    function makeAttack(partial) {
        return {
            type: 'melee',
            arc: 80,
            yLow: 0,
            yHigh: 0.9,
            hitstun: 0.34,
            blockstun: 0.22,
            knockback: 6,
            launch: 0,
            knockdown: false,
            energyCost: 0,
            energyGain: 4,
            guardDamage: 8,
            hitstop: 0.05,
            shake: 0.1,
            windup: {},
            strike: {},
            ...partial,
        };
    }
});
define("data/characters", ["require", "exports", "data/moves"], function (require, exports, moves_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.CHARACTERS = exports.RIBUT = exports.GORRATH = exports.ZEPHYR = exports.SOLARIS = void 0;
    // All three fighters are ORIGINAL designs. The registry is data-driven, so licensed or fan characters
    // can be added later as extra CharacterDef entries without touching the combat engine.
    // ---------------------------------------------------------------- SOLARIS
    // Balanced silver hero with a power timer: strong early, weaker once the timer runs out.
    const solarisBeam = {
        name: 'Prism Beam',
        color: [0.35, 0.78, 1],
        coreColor: [1, 1, 1],
        energyCost: 38,
        minCharge: 0.6,
        maxCharge: 1.8,
        length: 80,
        width: 3.6,
        durationMin: 0.8,
        durationMax: 1.5,
        tickInterval: 0.12,
        tickDamageMin: 14,
        tickDamageMax: 30,
        recovery: 0.55,
        aimSpeed: 0.9,
        hitstun: 0.22,
        knockback: 5,
        windup: { shL: 1.4, elL: 0.9, shR: 1.4, elR: 0.9, torsoPitch: -0.1 },
        strike: { shL: 1.55, elL: 0.1, shR: 1.55, elR: 0.1, torsoPitch: 0.05 },
    };
    exports.SOLARIS = {
        id: 'solaris',
        name: 'Solaris',
        title: 'Guardian of the Dawn',
        category: 'Original Hero - Balanced',
        archetype: 'balanced',
        blurb: 'Flexible silver hero. Solid combos, a reliable disc projectile and a charged Prism Beam. His power timer drains as the fight drags on.',
        stats: {
            maxHp: 1000, speed: 14, accel: 70, turnRate: 5, mass: 100, power: 1, defense: 20,
            maxEnergy: 100, energyRegen: 2.5, maxGuard: 100, jumpSpeed: 24, dodgeSpeed: 38,
            dodgeTime: 0.28, dodgeInvuln: 0.22, dodgeCooldown: 0.7, radius: 2.2, height: 10,
        },
        moves: {
            lights: [
                (0, moves_js_1.makeAttack)({
                    id: 'sol-l1', name: 'Jab', startup: 0.12, active: 0.08, recovery: 0.16, damage: 38, reach: 7.2,
                    arc: 70, hitstun: 0.32, knockback: 5, cancelAt: 0.14, hitstop: 0.04,
                    windup: { shR: -0.4, elR: 1.3, torsoYaw: 0.25 }, strike: { shR: 1.5, elR: 0.1, torsoYaw: -0.3 },
                }),
                (0, moves_js_1.makeAttack)({
                    id: 'sol-l2', name: 'Cross', startup: 0.14, active: 0.08, recovery: 0.18, damage: 42, reach: 7.4,
                    arc: 70, hitstun: 0.34, knockback: 8, cancelAt: 0.16, hitstop: 0.05,
                    windup: { shL: -0.4, elL: 1.3, torsoYaw: -0.3 }, strike: { shL: 1.55, elL: 0.1, torsoYaw: 0.35 },
                }),
                (0, moves_js_1.makeAttack)({
                    id: 'sol-l3', name: 'Rising Kick', startup: 0.18, active: 0.09, recovery: 0.3, damage: 58, reach: 8.2,
                    arc: 80, knockback: 14, knockdown: true, hitstop: 0.08, shake: 0.3, guardDamage: 14,
                    windup: { hipR: -0.5, knR: 0.9, torsoPitch: -0.12 }, strike: { hipR: 1.5, knR: 0.1, torsoPitch: 0.08 },
                }),
            ],
            heavy: (0, moves_js_1.makeAttack)({
                id: 'sol-h', name: 'Power Chop', startup: 0.3, active: 0.12, recovery: 0.42, damage: 96, reach: 8.2,
                arc: 90, hitstun: 0.6, knockback: 18, knockdown: true, hitstop: 0.11, shake: 0.5, guardDamage: 28, cancelAt: 0.34,
                windup: { shR: 2.7, elR: 0.5, torsoPitch: -0.25 }, strike: { shR: 0.6, elR: 0.1, torsoPitch: 0.3 },
            }),
            heavyForward: (0, moves_js_1.makeAttack)({
                id: 'sol-hf', name: 'Rising Elbow', startup: 0.26, active: 0.1, recovery: 0.46, damage: 72, reach: 8,
                arc: 70, hitstun: 0.5, knockback: 6, launch: 22, knockdown: true, lungeSpeed: 20, lungeTime: 0.28,
                hitstop: 0.1, shake: 0.45, guardDamage: 22, cancelAt: 0.3,
                windup: { shR: -0.2, elR: 1.6, torsoYaw: 0.4 }, strike: { shR: 2.4, elR: 1.5, torsoYaw: -0.3, torsoPitch: -0.1 },
            }),
            jumpAttack: (0, moves_js_1.makeAttack)({
                id: 'sol-j', name: 'Dive Kick', startup: 0.08, active: 0.35, recovery: 0.2, damage: 62, reach: 8.5,
                arc: 100, yLow: -0.3, yHigh: 1, knockback: 14, knockdown: true, air: true, hitstop: 0.08, shake: 0.3,
                windup: { hipR: -0.4, knR: 1 }, strike: { hipR: 1.2, hipL: 0.8, knR: 0.1, torsoPitch: 0.3 },
            }),
            special: (0, moves_js_1.makeAttack)({
                id: 'sol-s', name: 'Slash Disc', type: 'projectile', startup: 0.38, active: 0.02, recovery: 0.42,
                damage: 85, reach: 0, energyCost: 22, hitstun: 0.45, knockback: 12, knockdown: true, cooldown: 0.5,
                hitstop: 0.08, shake: 0.3, guardDamage: 18, energyGain: 3,
                projectile: { speed: 85, radius: 2, life: 1.3, color: [1, 0.85, 0.3], heightFrac: 0.62 },
                windup: { shR: 2.8, elR: 0.3, torsoYaw: 0.3 }, strike: { shR: 1.3, elR: 0.1, torsoYaw: -0.3 },
            }),
            grab: (0, moves_js_1.makeAttack)({
                id: 'sol-g', name: 'Shoulder Throw', type: 'throw', startup: 0.24, active: 0.1, recovery: 0.6, damage: 100,
                throwDamage: 130, reach: 6.2, arc: 80, knockback: 20, knockdown: true, hitstop: 0.12, shake: 0.6,
                windup: { shL: 1.3, elL: 0.7, shR: 1.3, elR: 0.7 }, strike: { shL: 1.5, elL: 0.3, shR: 1.5, elR: 0.3 },
            }),
            beam: solarisBeam,
            ultimate: {
                name: 'Dawn Prism Cannon', kind: 'beam', energyCost: 85, sound: 'beam',
                color: [1, 0.85, 0.4], coreColor: [1, 1, 1],
                cinematic: { closeUp: 0.8, chargeShake: 0.25, fireShake: 0.6, slowmo: 0.45 },
                beamPower: 4.5,
                attack: (0, moves_js_1.makeAttack)({
                    id: 'sol-ult', name: 'Dawn Prism Cannon', type: 'beam', startup: 1.05, active: 0.05, recovery: 0.1,
                    damage: 0, reach: 0, armor: 70, hitstop: 0,
                    windup: { shL: 2.6, shR: 2.6, shLr: 0.9, shRr: 0.9, elL: 0.3, elR: 0.3, torsoPitch: -0.2, headTilt: -0.3, hipL: 0.15, hipR: 0.15, knL: 0.3, knR: 0.3 },
                    strike: { shL: 1.55, shR: 1.55, elL: 0.05, elR: 0.05, torsoPitch: 0.1 },
                }),
                beam: {
                    name: 'Dawn Prism Cannon', color: [1, 0.85, 0.4], coreColor: [1, 1, 1], energyCost: 0, minCharge: 0, maxCharge: 0,
                    length: 110, width: 7.5, durationMin: 1.5, durationMax: 1.5, tickInterval: 0.1, tickDamageMin: 30, tickDamageMax: 30,
                    guardDamage: 9, recovery: 0.9, aimSpeed: 0.5, hitstun: 0.25, knockback: 7,
                    windup: {}, strike: { shL: 1.55, shR: 1.55, elL: 0.05, elR: 0.05, torsoPitch: 0.1, hipL: 0.3, hipR: -0.25, knL: 0.5, knR: 0.2 },
                },
            },
        },
        ai: { preferredRange: 4, aggression: 0.55, caution: 0.5, beamLove: 0.35 },
        timer: { seconds: 75, powerMul: 0.75, speedMul: 0.85 },
        rig: {
            style: 'hero', bulk: 1, headScale: 1,
            colors: {
                body: [0.82, 0.84, 0.9], limb: [0.78, 0.8, 0.88], accent: [0.85, 0.1, 0.12],
                glow: [0.3, 0.75, 1], eye: [1, 0.9, 0.4],
            },
            stance: { crouch: 0.05, lean: 0.04, armSpread: 0.25, elbow: 0.5 },
            extras: ['crest', 'timer'],
        },
        forms: [
            {
                id: 'blaze', name: 'Blaze Type', aura: [1, 0.5, 0.15], energyCost: 35, duration: 22, cooldown: 6,
                windup: 1.3, closeUp: 0.7, burst: 1.3, pitch: 0.85,
                blurb: 'Hits harder and swaps Slash Disc for the Flare Burst shockwave, but is slower and easier to hurt.',
                statMul: { power: 1.3, speed: 0.92, accel: 0.95, defense: 0.75 },
                moves: {
                    special: (0, moves_js_1.makeAttack)({
                        id: 'sol-blaze-s', name: 'Flare Burst', type: 'aoe', startup: 0.34, active: 0.05, recovery: 0.5,
                        damage: 90, reach: 0, radius: 11, energyCost: 30, hitstun: 0.5, knockback: 16, knockdown: true,
                        cooldown: 1, hitstop: 0.1, shake: 0.5, guardDamage: 24,
                        windup: { shL: 0.4, shR: 0.4, elL: 1.2, elR: 1.2, torsoPitch: -0.2 },
                        strike: { shL: 2.6, shR: 2.6, shLr: 0.8, shRr: 0.8, elL: 0.2, elR: 0.2, torsoPitch: 0.15 },
                    }),
                    beam: { ...solarisBeam, name: 'Blaze Beam', color: [1, 0.5, 0.15], tickDamageMin: 18, tickDamageMax: 38, aimSpeed: 0.7 },
                    ultimate: {
                        name: 'Solar Nova', kind: 'projectile', energyCost: 80, sound: 'nova',
                        color: [1, 0.5, 0.15], coreColor: [1, 0.95, 0.7],
                        cinematic: { closeUp: 0.75, chargeShake: 0.25, fireShake: 0.7, slowmo: 0.45 },
                        attack: (0, moves_js_1.makeAttack)({
                            id: 'sol-blaze-ult', name: 'Solar Nova', type: 'projectile', startup: 0.95, active: 0.05, recovery: 0.6,
                            damage: 260, reach: 0, armor: 70, hitstun: 0.8, knockback: 20, knockdown: true, noScale: true,
                            hitstop: 0.22, shake: 0.85, guardDamage: 80, energyGain: 0,
                            projectile: { speed: 55, radius: 6, life: 1.7, color: [1, 0.5, 0.15], heightFrac: 0.55 },
                            windup: { shL: 2.7, shR: 2.7, elL: 0.4, elR: 0.4, torsoPitch: -0.3, headTilt: -0.3 },
                            strike: { shL: 1.4, shR: 1.4, elL: 0.1, elR: 0.1, torsoPitch: 0.25 },
                        }),
                    },
                },
                colors: { body: [0.86, 0.4, 0.22], limb: [0.82, 0.55, 0.4], accent: [1, 0.75, 0.15], glow: [1, 0.5, 0.15] },
            },
            {
                id: 'aegis', name: 'Aegis Type', aura: [0.35, 0.65, 1], energyCost: 30, duration: 22, cooldown: 6,
                windup: 1.1, closeUp: 0.5, burst: 1, pitch: 1,
                blurb: 'Armoured form with a far tougher guard and a shield-bash special that shrugs off light hits.',
                statMul: { defense: 1.9, maxGuard: 1.6, speed: 0.95, power: 0.9 },
                moves: {
                    special: (0, moves_js_1.makeAttack)({
                        id: 'sol-aegis-s', name: 'Aegis Bash', startup: 0.3, active: 0.1, recovery: 0.5, damage: 70, reach: 7.8,
                        arc: 90, energyCost: 20, hitstun: 0.5, knockback: 14, knockdown: true, armor: 60, cooldown: 0.8,
                        hitstop: 0.1, shake: 0.4, guardDamage: 45, lungeSpeed: 22, lungeTime: 0.25,
                        windup: { shL: -0.5, elL: 1.5, torsoYaw: -0.4 }, strike: { shL: 1.6, elL: 0.6, torsoYaw: 0.4 },
                    }),
                },
                colors: { body: [0.45, 0.6, 0.9], limb: [0.7, 0.78, 0.92], accent: [0.9, 0.9, 1], glow: [0.35, 0.65, 1] },
            },
        ],
    };
    // ----------------------------------------------------------------- ZEPHYR
    // Fast blue/gold hero. Four-hit strings, short reach, quick dodge, thin beam.
    const zephyrBeam = {
        name: 'Pulse Lance',
        color: [1, 0.85, 0.3],
        coreColor: [1, 1, 0.9],
        energyCost: 28,
        minCharge: 0.35,
        maxCharge: 1.0,
        length: 70,
        width: 2.4,
        durationMin: 0.6,
        durationMax: 1.0,
        tickInterval: 0.1,
        tickDamageMin: 9,
        tickDamageMax: 19,
        recovery: 0.35,
        aimSpeed: 1.3,
        hitstun: 0.18,
        knockback: 4,
        windup: { shR: 1.2, elR: 1.0, shL: 0.6, elL: 1.2, torsoYaw: 0.3 },
        strike: { shR: 1.6, elR: 0.05, shL: 0.5, elL: 1.4, torsoYaw: -0.1 },
    };
    exports.ZEPHYR = {
        id: 'zephyr',
        name: 'Zephyr',
        title: 'Storm Runner',
        category: 'Original Hero - Speed',
        archetype: 'speed',
        blurb: 'Blisteringly quick. Long strings of weak hits, a lunging Blitz Dash and a fast Pulse Lance - but he cannot take punishment.',
        stats: {
            maxHp: 850, speed: 17.5, accel: 90, turnRate: 7, mass: 80, power: 0.95, defense: 10,
            maxEnergy: 100, energyRegen: 3.2, maxGuard: 80, jumpSpeed: 26, dodgeSpeed: 44,
            dodgeTime: 0.24, dodgeInvuln: 0.2, dodgeCooldown: 0.5, radius: 1.9, height: 9,
        },
        moves: {
            lights: [
                (0, moves_js_1.makeAttack)({
                    id: 'zep-l1', name: 'Flick', startup: 0.08, active: 0.06, recovery: 0.12, damage: 24, reach: 6.4, arc: 70,
                    hitstun: 0.26, knockback: 3, cancelAt: 0.1, hitstop: 0.03, guardDamage: 5,
                    windup: { shL: -0.3, elL: 1.2, torsoYaw: -0.2 }, strike: { shL: 1.5, elL: 0.1, torsoYaw: 0.25 },
                }),
                (0, moves_js_1.makeAttack)({
                    id: 'zep-l2', name: 'Flick II', startup: 0.08, active: 0.06, recovery: 0.12, damage: 26, reach: 6.4, arc: 70,
                    hitstun: 0.26, knockback: 3, cancelAt: 0.1, hitstop: 0.03, guardDamage: 5,
                    windup: { shR: -0.3, elR: 1.2, torsoYaw: 0.2 }, strike: { shR: 1.5, elR: 0.1, torsoYaw: -0.25 },
                }),
                (0, moves_js_1.makeAttack)({
                    id: 'zep-l3', name: 'Snap Kick', startup: 0.1, active: 0.07, recovery: 0.14, damage: 28, reach: 7, arc: 80,
                    hitstun: 0.28, knockback: 6, cancelAt: 0.12, hitstop: 0.04, guardDamage: 6,
                    windup: { hipL: -0.4, knL: 0.8 }, strike: { hipL: 1.4, knL: 0.1, torsoPitch: 0.05 },
                }),
                (0, moves_js_1.makeAttack)({
                    id: 'zep-l4', name: 'Whirl Kick', startup: 0.14, active: 0.08, recovery: 0.26, damage: 46, reach: 7.6, arc: 120,
                    knockback: 14, knockdown: true, hitstop: 0.07, shake: 0.25, guardDamage: 10,
                    windup: { hipR: -0.5, knR: 1, torsoYaw: 0.8 }, strike: { hipR: 1.5, knR: 0.1, torsoYaw: -0.9 },
                }),
            ],
            heavy: (0, moves_js_1.makeAttack)({
                id: 'zep-h', name: 'Spin Kick', startup: 0.22, active: 0.1, recovery: 0.3, damage: 70, reach: 7.8, arc: 140,
                hitstun: 0.5, knockback: 16, knockdown: true, hitstop: 0.08, shake: 0.4, guardDamage: 20, cancelAt: 0.26,
                windup: { hipR: -0.6, knR: 1.1, torsoYaw: 1 }, strike: { hipR: 1.6, knR: 0.1, torsoYaw: -1.2 },
            }),
            heavyForward: (0, moves_js_1.makeAttack)({
                id: 'zep-hf', name: 'Rising Slash', startup: 0.2, active: 0.1, recovery: 0.4, damage: 56, reach: 7.4,
                arc: 70, hitstun: 0.45, knockback: 5, launch: 24, knockdown: true, lungeSpeed: 26, lungeTime: 0.24,
                hitstop: 0.08, shake: 0.35, guardDamage: 16,
                windup: { shL: -0.3, elL: 1.5, torsoYaw: -0.4 }, strike: { shL: 2.6, elL: 0.3, torsoYaw: 0.3 },
            }),
            jumpAttack: (0, moves_js_1.makeAttack)({
                id: 'zep-j', name: 'Skydive Strike', startup: 0.06, active: 0.3, recovery: 0.16, damage: 50, reach: 8,
                arc: 110, yLow: -0.3, yHigh: 1, knockback: 12, knockdown: true, air: true, hitstop: 0.07, shake: 0.25,
                windup: { hipL: -0.3, knL: 1 }, strike: { hipL: 1.2, hipR: 0.8, knL: 0.1, torsoPitch: 0.35 },
            }),
            special: (0, moves_js_1.makeAttack)({
                id: 'zep-s', name: 'Blitz Dash', startup: 0.15, active: 0.25, recovery: 0.55, damage: 80, reach: 8,
                arc: 60, knockback: 14, knockdown: true, lungeSpeed: 74, lungeTime: 0.3, energyCost: 25, cooldown: 0.6,
                hitstop: 0.09, shake: 0.35, guardDamage: 20, tracks: true,
                windup: { shR: -0.6, elR: 1.4, torsoPitch: 0.3 }, strike: { shR: 1.6, elR: 0.1, torsoPitch: 0.5, hipL: 0.6 },
            }),
            grab: (0, moves_js_1.makeAttack)({
                id: 'zep-g', name: 'Flip Throw', type: 'throw', startup: 0.2, active: 0.1, recovery: 0.55, damage: 90,
                throwDamage: 105, reach: 5.6, arc: 80, knockback: 18, knockdown: true, hitstop: 0.1, shake: 0.5,
                windup: { shL: 1.3, elL: 0.7, shR: 1.3, elR: 0.7 }, strike: { shL: 1.5, elL: 0.3, shR: 1.5, elR: 0.3 },
            }),
            beam: zephyrBeam,
            ultimate: {
                name: 'Storm Barrage', kind: 'finisher', energyCost: 80, sound: 'strike',
                color: [0.4, 0.9, 1], coreColor: [1, 1, 1],
                cinematic: { closeUp: 0.65, chargeShake: 0.2, fireShake: 0.45, slowmo: 0.5 },
                attack: (0, moves_js_1.makeAttack)({
                    id: 'zep-ult', name: 'Storm Barrage', startup: 0.8, active: 0.55, recovery: 0.7, damage: 55, reach: 9, arc: 90,
                    yHigh: 1, hits: 6, hitstun: 0.35, knockback: 2.5, lungeSpeed: 62, lungeTime: 0.55, lungeStart: 0.8, tracks: true,
                    armor: 70, guardable: false, noScale: true, hitstop: 0.04, shake: 0.2, guardDamage: 0, energyGain: 2,
                    finale: { damage: 80, knockback: 22, launch: 20 },
                    windup: { hipL: 0.6, hipR: 0.6, knL: 1.1, knR: 1.1, torsoPitch: 0.5, shL: -0.6, shR: -0.6, elL: 1.2, elR: 1.2 },
                    strike: { shL: 1.6, shR: 1.0, elL: 0.1, elR: 0.2, torsoPitch: 0.5, hipL: 0.8, knL: 0.2 },
                }),
            },
        },
        ai: { preferredRange: 3, aggression: 0.75, caution: 0.4, beamLove: 0.2 },
        rig: {
            style: 'speed', bulk: 0.85, headScale: 0.95,
            colors: {
                body: [0.15, 0.36, 0.82], limb: [0.86, 0.89, 0.96], accent: [0.96, 0.76, 0.16],
                glow: [0.4, 0.9, 1], eye: [0.7, 1, 1],
            },
            stance: { crouch: 0.16, lean: 0.14, armSpread: 0.35, elbow: 1.0 },
            extras: ['fins'],
        },
        forms: [
            {
                id: 'overdrive', name: 'Overdrive', aura: [1, 0.3, 0.7], energyCost: 30, duration: 16, cooldown: 8,
                windup: 0.9, closeUp: 0.6, burst: 0.8, pitch: 1.35,
                blurb: 'Pushes his speed past its limit for a short burst. Hits a little lighter and takes far more damage.',
                statMul: { speed: 1.22, accel: 1.2, turnRate: 1.15, dodgeSpeed: 1.1, power: 0.92, defense: 0.6 },
                colors: { body: [0.55, 0.12, 0.5], accent: [1, 0.35, 0.65], glow: [1, 0.3, 0.7] },
            },
        ],
    };
    // ---------------------------------------------------------------- GORRATH
    // Armoured kaiju. Slow turning, huge reach, super-armoured heavies, ground-shaking stomp, enrages when hurt.
    const gorrathBeam = {
        name: 'Magma Breath',
        color: [1, 0.42, 0.1],
        coreColor: [1, 0.92, 0.5],
        energyCost: 50,
        minCharge: 0.9,
        maxCharge: 2.4,
        length: 70,
        width: 5,
        durationMin: 1,
        durationMax: 1.9,
        tickInterval: 0.14,
        tickDamageMin: 20,
        tickDamageMax: 38,
        recovery: 0.7,
        aimSpeed: 0.6,
        hitstun: 0.26,
        knockback: 6,
        windup: { headTilt: -0.5, torsoPitch: -0.2, shL: 0.5, shR: 0.5 },
        strike: { headTilt: 0.35, torsoPitch: 0.2, shL: 0.3, shR: 0.3 },
    };
    exports.GORRATH = {
        id: 'gorrath',
        name: 'Gorrath',
        title: 'Magma Tyrant',
        category: 'Original Kaiju - Armored Brute',
        archetype: 'armored-monster',
        blurb: 'A mountain of scales. Slow to turn, but his heavy swings shrug off weak hits, Quake Stomp punishes grounded foes and he enrages when badly hurt.',
        stats: {
            maxHp: 1300, speed: 9.5, accel: 40, turnRate: 1.9, mass: 320, power: 1.15, defense: 40,
            maxEnergy: 100, energyRegen: 2, maxGuard: 160, jumpSpeed: 18, dodgeSpeed: 26,
            dodgeTime: 0.36, dodgeInvuln: 0.26, dodgeCooldown: 1.0, radius: 3.8, height: 12,
        },
        moves: {
            lights: [
                (0, moves_js_1.makeAttack)({
                    id: 'gor-l1', name: 'Claw Swipe', startup: 0.26, active: 0.1, recovery: 0.3, damage: 55, reach: 10, arc: 90,
                    hitstun: 0.4, knockback: 8, cancelAt: 0.3, hitstop: 0.06, guardDamage: 14,
                    windup: { shR: 2.2, elR: 0.5, torsoYaw: 0.5 }, strike: { shR: 0.5, elR: 0.2, torsoYaw: -0.6 },
                }),
                (0, moves_js_1.makeAttack)({
                    id: 'gor-l2', name: 'Rending Slam', startup: 0.3, active: 0.12, recovery: 0.4, damage: 74, reach: 10.5, arc: 90,
                    hitstun: 0.5, knockback: 14, knockdown: true, armor: 40, hitstop: 0.1, shake: 0.4, guardDamage: 24,
                    windup: { shL: 2.4, elL: 0.4, shR: 2.4, elR: 0.4, torsoPitch: -0.3 }, strike: { shL: 0.5, elL: 0.1, shR: 0.5, elR: 0.1, torsoPitch: 0.4 },
                }),
            ],
            heavy: (0, moves_js_1.makeAttack)({
                id: 'gor-h', name: 'Tail Sweep', startup: 0.42, active: 0.14, recovery: 0.55, damage: 100, reach: 11, arc: 220,
                yHigh: 0.32, hitstun: 0.6, knockback: 22, knockdown: true, armor: 60, hitstop: 0.12, shake: 0.55, guardDamage: 30,
                windup: { torsoYaw: 0.9, tail: -1.2 }, strike: { torsoYaw: -1.3, tail: 1.4 },
            }),
            heavyForward: (0, moves_js_1.makeAttack)({
                id: 'gor-hf', name: 'Maw Crush', startup: 0.35, active: 0.1, recovery: 0.5, damage: 90, reach: 10, arc: 70,
                hitstun: 0.5, knockback: 8, launch: 18, knockdown: true, lungeSpeed: 22, lungeTime: 0.3, armor: 50,
                hitstop: 0.12, shake: 0.5, guardDamage: 26,
                windup: { headTilt: -0.7, torsoPitch: -0.3 }, strike: { headTilt: 0.5, torsoPitch: 0.5 },
            }),
            jumpAttack: (0, moves_js_1.makeAttack)({
                id: 'gor-j', name: 'Belly Flop', startup: 0.1, active: 0.4, recovery: 0.3, damage: 80, reach: 10,
                arc: 120, yLow: -0.3, yHigh: 1, knockback: 16, knockdown: true, air: true, hitstop: 0.1, shake: 0.5,
                windup: { torsoPitch: -0.2 }, strike: { torsoPitch: 0.9, shL: 1.5, shR: 1.5 },
            }),
            special: (0, moves_js_1.makeAttack)({
                id: 'gor-s', name: 'Quake Stomp', type: 'aoe', startup: 0.55, active: 0.05, recovery: 0.6, damage: 90,
                reach: 0, radius: 19, energyCost: 30, hitstun: 0.5, knockback: 14, knockdown: true, cooldown: 0.8,
                hitstop: 0.12, shake: 0.8, guardDamage: 25, energyGain: 3,
                windup: { hipR: 1.4, knR: 1.2, shL: 1.2, shR: 1.2, torsoPitch: -0.2 }, strike: { hipR: 0.1, knR: 0.1, torsoPitch: 0.25, shL: 0.2, shR: 0.2 },
            }),
            grab: (0, moves_js_1.makeAttack)({
                id: 'gor-g', name: 'Maw Throw', type: 'throw', startup: 0.35, active: 0.1, recovery: 0.7, damage: 110,
                throwDamage: 150, reach: 8.4, arc: 90, knockback: 24, knockdown: true, hitstop: 0.14, shake: 0.7,
                windup: { shL: 1.2, shR: 1.2, elL: 0.5, elR: 0.5 }, strike: { shL: 1.5, shR: 1.5, elL: 0.2, elR: 0.2 },
            }),
            beam: gorrathBeam,
            ultimate: {
                name: 'Titan Quake', kind: 'shockwave', energyCost: 90, sound: 'quake',
                color: [1, 0.42, 0.1], coreColor: [1, 0.9, 0.5],
                cinematic: { closeUp: 0.55, chargeShake: 0.35, fireShake: 0.95, slowmo: 0.5 },
                attack: (0, moves_js_1.makeAttack)({
                    id: 'gor-ult', name: 'Titan Quake', type: 'aoe', startup: 1.15, active: 0.05, recovery: 0.8, damage: 300, reach: 0,
                    radius: 26, armor: 70, hitstun: 0.8, knockback: 24, knockdown: true, noScale: true, hitstop: 0.25, shake: 0.9,
                    guardDamage: 95, energyGain: 0,
                    windup: { shL: 2.8, shR: 2.8, elL: 0.3, elR: 0.3, torsoPitch: -0.35, headTilt: -0.4 },
                    strike: { shL: 0.3, shR: 0.3, torsoPitch: 0.6, headTilt: 0.5, hipL: 0.3, hipR: 0.3, knL: 0.4, knR: 0.4 },
                }),
            },
        },
        ai: { preferredRange: 3.5, aggression: 0.6, caution: 0.25, beamLove: 0.4 },
        enrage: { belowHp: 0.35, powerMul: 1.2, speedMul: 1.15 },
        rig: {
            style: 'kaiju', bulk: 1.35, headScale: 1.1,
            colors: {
                body: [0.18, 0.34, 0.2], limb: [0.24, 0.4, 0.22], accent: [0.95, 0.45, 0.1],
                glow: [1, 0.5, 0.1], eye: [1, 0.2, 0.1],
            },
            stance: { crouch: 0.22, lean: 0.2, armSpread: 0.5, elbow: 0.7 },
            extras: ['tail', 'spikes', 'jaw', 'horns'],
        },
    };
    // ----------------------------------------------------------------- RIBUT
    // Ranged swordsman ("ribut" = storm). Fights from a distance with thrown discs and a charged energy wave,
    // but his sword slice outreaches his fists, so he is dangerous at mid range and fragile up close.
    const ributBeam = {
        name: 'Charged Wave',
        color: [0.45, 0.85, 1],
        coreColor: [1, 1, 1],
        energyCost: 32,
        minCharge: 0.45,
        maxCharge: 1.4,
        length: 90,
        width: 3,
        durationMin: 0.7,
        durationMax: 1.2,
        tickInterval: 0.1,
        tickDamageMin: 12,
        tickDamageMax: 26,
        recovery: 0.45,
        aimSpeed: 1.1,
        hitstun: 0.2,
        knockback: 5,
        windup: { shR: 2.8, elR: 0.4, torsoYaw: 0.4, torsoPitch: -0.15 },
        strike: { shR: 1.5, elR: 0.05, torsoYaw: -0.3, torsoPitch: 0.1 },
    };
    exports.RIBUT = {
        id: 'ribut',
        name: 'Ribut',
        title: 'Storm Blade',
        category: 'Original Hero - Ranged Swordsman',
        archetype: 'ranged',
        blurb: 'Keeps his distance and floods the arena with Storm Discs, then closes with a Charge Slash. Punch, punch, slice is his basic chain; hold the beam button to charge a long cutting wave. Thin defences up close.',
        stats: {
            maxHp: 900, speed: 15, accel: 75, turnRate: 5.5, mass: 90, power: 1, defense: 12,
            maxEnergy: 100, energyRegen: 4, maxGuard: 90, jumpSpeed: 25, dodgeSpeed: 40,
            dodgeTime: 0.26, dodgeInvuln: 0.2, dodgeCooldown: 0.6, radius: 2, height: 9.5,
        },
        moves: {
            lights: [
                (0, moves_js_1.makeAttack)({
                    id: 'rib-l1', name: 'Punch', startup: 0.1, active: 0.07, recovery: 0.14, damage: 30, reach: 6.6, arc: 70,
                    hitstun: 0.3, knockback: 4, cancelAt: 0.12, hitstop: 0.04, guardDamage: 6,
                    windup: { shL: -0.4, elL: 1.3, torsoYaw: -0.25 }, strike: { shL: 1.5, elL: 0.1, torsoYaw: 0.3 },
                }),
                (0, moves_js_1.makeAttack)({
                    id: 'rib-l2', name: 'Straight', startup: 0.11, active: 0.07, recovery: 0.15, damage: 34, reach: 6.8, arc: 70,
                    hitstun: 0.32, knockback: 6, cancelAt: 0.13, hitstop: 0.05, guardDamage: 7,
                    windup: { shL: -0.5, elL: 1.2, torsoYaw: -0.35 }, strike: { shL: 1.6, elL: 0.05, torsoYaw: 0.4 },
                }),
                (0, moves_js_1.makeAttack)({
                    id: 'rib-l3', name: 'Sword Slice', startup: 0.16, active: 0.1, recovery: 0.3, damage: 62, reach: 9.6, arc: 110,
                    knockback: 14, knockdown: true, hitstop: 0.08, shake: 0.3, guardDamage: 14,
                    windup: { shR: 2.6, elR: 0.4, torsoYaw: 0.6, torsoPitch: -0.2 }, strike: { shR: 0.5, elR: 0.1, torsoYaw: -0.9, torsoPitch: 0.25 },
                }),
            ],
            heavy: (0, moves_js_1.makeAttack)({
                id: 'rib-h', name: 'Crescent Cleave', startup: 0.28, active: 0.12, recovery: 0.4, damage: 90, reach: 9.8, arc: 120,
                hitstun: 0.55, knockback: 16, knockdown: true, hitstop: 0.1, shake: 0.45, guardDamage: 26, cancelAt: 0.32,
                windup: { shR: 2.9, elR: 0.3, torsoPitch: -0.3, torsoYaw: 0.5 }, strike: { shR: 0.4, elR: 0.1, torsoPitch: 0.35, torsoYaw: -0.7 },
            }),
            heavyForward: (0, moves_js_1.makeAttack)({
                id: 'rib-hf', name: 'Charge Slash', startup: 0.22, active: 0.12, recovery: 0.45, damage: 76, reach: 9.2, arc: 70,
                hitstun: 0.5, knockback: 8, launch: 20, knockdown: true, lungeSpeed: 46, lungeTime: 0.3, lungeStart: 0.12,
                hitstop: 0.1, shake: 0.4, guardDamage: 22, cancelAt: 0.3,
                windup: { shR: 2.4, elR: 0.5, torsoYaw: 0.5, torsoPitch: 0.1 }, strike: { shR: 0.7, elR: 0.1, torsoYaw: -0.5, torsoPitch: 0.5 },
            }),
            jumpAttack: (0, moves_js_1.makeAttack)({
                id: 'rib-j', name: 'Plunge Slash', startup: 0.08, active: 0.35, recovery: 0.2, damage: 58, reach: 9, arc: 100,
                yLow: -0.3, yHigh: 1, knockback: 13, knockdown: true, air: true, hitstop: 0.08, shake: 0.3,
                windup: { shR: 2.8, elR: 0.3, hipL: 0.4, knL: 0.8 }, strike: { shR: 0.6, elR: 0.1, torsoPitch: 0.3, hipL: 1, knL: 0.2 },
            }),
            special: (0, moves_js_1.makeAttack)({
                id: 'rib-s', name: 'Storm Disc', type: 'projectile', startup: 0.3, active: 0.02, recovery: 0.34, damage: 70,
                reach: 0, energyCost: 14, hitstun: 0.4, knockback: 10, knockdown: true, cooldown: 0.4, hitstop: 0.07,
                shake: 0.25, guardDamage: 16, energyGain: 3,
                projectile: { speed: 78, radius: 1.9, life: 1.4, color: [0.5, 0.9, 1], heightFrac: 0.6 },
                windup: { shL: 2.7, elL: 0.4, torsoYaw: -0.3 }, strike: { shL: 1.3, elL: 0.1, torsoYaw: 0.35 },
            }),
            grab: (0, moves_js_1.makeAttack)({
                id: 'rib-g', name: 'Pommel Throw', type: 'throw', startup: 0.22, active: 0.1, recovery: 0.55, damage: 85,
                throwDamage: 110, reach: 5.8, arc: 80, knockback: 18, knockdown: true, hitstop: 0.1, shake: 0.5,
                windup: { shL: 1.3, elL: 0.7, shR: 1.3, elR: 0.7 }, strike: { shL: 1.5, elL: 0.3, shR: 1.5, elR: 0.3 },
            }),
            beam: ributBeam,
            ultimate: {
                name: 'Tempest Disc', kind: 'projectile', energyCost: 85, sound: 'nova',
                color: [0.5, 0.9, 1], coreColor: [1, 1, 1],
                cinematic: { closeUp: 0.7, chargeShake: 0.22, fireShake: 0.6, slowmo: 0.45 },
                attack: (0, moves_js_1.makeAttack)({
                    id: 'rib-ult', name: 'Tempest Disc', type: 'projectile', startup: 0.95, active: 0.05, recovery: 0.55,
                    damage: 270, reach: 0, armor: 70, hitstun: 0.8, knockback: 20, knockdown: true, noScale: true,
                    hitstop: 0.22, shake: 0.85, guardDamage: 85, energyGain: 0,
                    projectile: { speed: 90, radius: 5, life: 1.5, color: [0.5, 0.9, 1], heightFrac: 0.55 },
                    windup: { shL: 2.8, shR: 2.8, elL: 0.3, elR: 0.3, torsoPitch: -0.3, headTilt: -0.3 },
                    strike: { shL: 1.4, shR: 1.4, elL: 0.1, elR: 0.1, torsoPitch: 0.25 },
                }),
            },
        },
        // Holds a long distance so that discs and the charged wave are his main tools.
        ai: { preferredRange: 12, aggression: 0.5, caution: 0.45, beamLove: 0.5 },
        rig: {
            style: 'hero', bulk: 0.95, headScale: 1,
            colors: {
                body: [0.18, 0.2, 0.42], limb: [0.7, 0.72, 0.86], accent: [1, 0.55, 0.15],
                glow: [0.45, 0.85, 1], eye: [0.9, 1, 1],
            },
            stance: { crouch: 0.1, lean: 0.1, armSpread: 0.3, elbow: 0.8 },
            extras: ['shoulders', 'sword'],
        },
    };
    exports.CHARACTERS = [exports.SOLARIS, exports.ZEPHYR, exports.GORRATH, exports.RIBUT];
});
define("characters/CharacterRegistry", ["require", "exports", "data/characters"], function (require, exports, characters_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.registry = exports.CharacterRegistry = exports.PLANNED_SLOTS = void 0;
    exports.PLANNED_SLOTS = [
        { id: 'slot-showa', group: 'Classic era heroes', note: 'Planned - needs original/licensed models, moves, animation' },
        { id: 'slot-heisei', group: 'Heisei era heroes (multi-form)', note: 'Planned - transformation framework exists (see Solaris/Zephyr); needs new characters and forms' },
        { id: 'slot-new-gen', group: 'New generation heroes', note: 'Planned' },
        { id: 'slot-reiwa', group: 'Reiwa era heroes', note: 'Planned' },
        { id: 'slot-fusion', group: 'Fusion heroes', note: 'Planned' },
        { id: 'slot-dark', group: 'Dark heroes and rivals', note: 'Planned' },
        { id: 'slot-flying-kaiju', group: 'Flying kaiju', note: 'Planned - needs airborne movement profile' },
        { id: 'slot-alien', group: 'Alien fighters', note: 'Planned' },
        { id: 'slot-robot', group: 'Robotic enemies', note: 'Planned' },
        { id: 'slot-boss', group: 'Multi-phase final bosses', note: 'Planned - needs boss phase system' },
    ];
    /** Data registry: add characters without touching combat code. */
    class CharacterRegistry {
        byId = new Map();
        constructor(defs = characters_js_1.CHARACTERS) {
            for (const d of defs)
                this.register(d);
        }
        register(def) {
            if (this.byId.has(def.id))
                throw new Error(`Duplicate character id: ${def.id}`);
            this.byId.set(def.id, def);
        }
        get(id) {
            const d = this.byId.get(id);
            if (!d)
                throw new Error(`Unknown character: ${id}`);
            return d;
        }
        has(id) {
            return this.byId.has(id);
        }
        list() {
            return [...this.byId.values()];
        }
    }
    exports.CharacterRegistry = CharacterRegistry;
    exports.registry = new CharacterRegistry();
});
define("render/Renderer", ["require", "exports", "math"], function (require, exports, math_js_6) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Renderer = exports.newMaterial = void 0;
    exports.resetMaterial = resetMaterial;
    const newMaterial = () => ({
        color: [1, 1, 1], color2: [0, 0, 0], emissive: [0, 0, 0], rimColor: [0.6, 0.8, 1],
        alpha: 1, flash: 0, rim: 0, spec: 0, mode: 0, additive: false,
    });
    exports.newMaterial = newMaterial;
    function resetMaterial(m) {
        m.color[0] = m.color[1] = m.color[2] = 1;
        m.color2[0] = m.color2[1] = m.color2[2] = 0;
        m.emissive[0] = m.emissive[1] = m.emissive[2] = 0;
        m.rimColor[0] = 0.6;
        m.rimColor[1] = 0.8;
        m.rimColor[2] = 1;
        m.alpha = 1;
        m.flash = 0;
        m.rim = 0;
        m.spec = 0;
        m.mode = 0;
        m.additive = false;
        return m;
    }
    const VERT = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uModel;
uniform mat3 uNormalMat;
out vec3 vWorld;
out vec3 vNormal;
void main(){
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vNormal = uNormalMat * aNormal;
  gl_Position = uViewProj * w;
}`;
    const FRAG = `#version 300 es
precision highp float;
in vec3 vWorld;
in vec3 vNormal;
uniform vec3 uColor, uColor2, uEmissive, uRimColor;
uniform vec3 uSunDir, uSunColor, uSkyAmb, uGroundAmb, uCamPos, uFogColor;
uniform float uFogDensity, uAlpha, uFlash, uRim, uSpec, uMode, uArenaR, uTime, uTheme;
out vec4 outColor;
float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main(){
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamPos - vWorld);
  vec3 base = uColor;
  vec3 emis = uEmissive;
  float dist = length(uCamPos - vWorld);
  vec3 col;
  if (uMode > 2.5 && uMode < 3.5) {
    float f = pow(max(dot(N, V), 0.0), 1.2);
    col = uColor * (0.55 + 0.9 * f) + uEmissive;
  } else if (uMode > 3.5) {
    col = uColor;
  } else {
    if (uMode > 0.5 && uMode < 1.5) {
      float r = length(vWorld.xz);
      vec2 g = abs(fract(vWorld.xz / 6.0) - 0.5);
      float line = smoothstep(0.455, 0.5, max(g.x, g.y));
      float inside = 1.0 - smoothstep(uArenaR - 0.5, uArenaR + 0.5, r);
      base = mix(uColor, uColor2, line * (0.25 + 0.55 * inside));
      base *= mix(0.55, 1.0, inside);
      float ring = smoothstep(uArenaR - 0.9, uArenaR - 0.15, r) * (1.0 - smoothstep(uArenaR - 0.15, uArenaR + 0.25, r));
      emis += uEmissive * ring * (1.2 + 0.4 * sin(uTime * 2.0));
      if (uTheme > 0.5) {
        // glowing lava cracks
        vec2 q = vWorld.xz * 0.11;
        float n = abs(sin(q.x * 3.1 + sin(q.y * 2.3) * 1.7) + sin(q.y * 3.7 + sin(q.x * 1.9) * 1.3));
        float crack = smoothstep(0.1, 0.0, n) * (0.4 + 0.6 * smoothstep(uArenaR * 0.55, uArenaR + 6.0, r));
        emis += vec3(1.0, 0.35, 0.05) * crack * (0.8 + 0.3 * sin(uTime * 1.3 + q.x));
      }
    } else if (uMode > 1.5 && uMode < 2.5) {
      vec2 w = vec2(vWorld.x + vWorld.z, vWorld.y) / vec2(2.6, 3.2);
      vec2 f = fract(w);
      float win = step(0.2, f.x) * step(f.x, 0.78) * step(0.3, f.y) * step(f.y, 0.72) * (1.0 - step(0.6, abs(N.y)));
      float lit = step(0.5, hash(floor(w)));
      base = mix(base, uColor2 * 0.35, win);
      emis += uEmissive * win * lit;
    }
    float ndl = max(dot(N, uSunDir), 0.0);
    vec3 amb = mix(uGroundAmb, uSkyAmb, N.y * 0.5 + 0.5);
    col = base * (amb + uSunColor * ndl);
    float rimF = pow(1.0 - max(dot(N, V), 0.0), 3.0) * uRim;
    col += uRimColor * rimF;
    vec3 H = normalize(uSunDir + V);
    col += uSunColor * pow(max(dot(N, H), 0.0), 36.0) * uSpec;
    col += emis;
  }
  col = mix(col, vec3(1.0), uFlash);
  float fog = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
  col = mix(col, uFogColor, clamp(fog, 0.0, 1.0) * (uMode > 2.5 && uMode < 3.5 ? 0.35 : 1.0));
  outColor = vec4(col, uAlpha);
}`;
    const SKY_VERT = `#version 300 es
out vec2 vUv;
void main(){
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p * 2.0 - 1.0;
  gl_Position = vec4(vUv, 0.9999, 1.0);
}`;
    const SKY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 uRight, uUp, uFwd, uTop, uHor, uSunDir, uSunColor;
uniform float uTan, uAspect, uStars, uTime;
out vec4 outColor;
float hash(vec3 p){ return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
void main(){
  vec3 d = normalize(uFwd + uRight * (vUv.x * uAspect * uTan) + uUp * (vUv.y * uTan));
  float t = clamp(d.y * 1.5 + 0.08, 0.0, 1.0);
  vec3 col = mix(uHor, uTop, pow(t, 0.55));
  if (d.y < 0.0) col = mix(uHor, uHor * 0.55, clamp(-d.y * 4.0, 0.0, 1.0));
  float s = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (pow(s, 600.0) * 2.0 + pow(s, 18.0) * 0.25);
  if (uStars > 0.01 && d.y > 0.0) {
    vec3 c = floor(d * 260.0);
    float h = hash(c);
    float star = step(0.9968, h) * (0.5 + 0.5 * sin(uTime * 1.7 + h * 60.0));
    col += vec3(star) * uStars * smoothstep(0.0, 0.25, d.y);
  }
  outColor = vec4(col, 1.0);
}`;
    function compile(gl, type, src) {
        const sh = gl.createShader(type);
        if (!sh)
            throw new Error('Could not create shader');
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            const log = gl.getShaderInfoLog(sh);
            gl.deleteShader(sh);
            throw new Error(`Shader compile failed: ${log}`);
        }
        return sh;
    }
    function link(gl, vs, fs) {
        const p = gl.createProgram();
        if (!p)
            throw new Error('Could not create program');
        gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
        gl.bindAttribLocation(p, 0, 'aPos');
        gl.bindAttribLocation(p, 1, 'aNormal');
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            throw new Error(`Program link failed: ${gl.getProgramInfoLog(p)}`);
        }
        return p;
    }
    function locations(gl, p, names) {
        const out = {};
        for (const n of names)
            out[n] = gl.getUniformLocation(p, n);
        return out;
    }
    class Renderer {
        canvas;
        gl;
        meshes;
        width = 1;
        height = 1;
        quality = 'high';
        contextLost = false;
        onContextRestored = null;
        time = 0;
        fovy = 0.78;
        aspect = 1;
        prog;
        u;
        skyProg;
        skyU;
        skyVao;
        view = (0, math_js_6.mat4)();
        proj = (0, math_js_6.mat4)();
        viewProj = (0, math_js_6.mat4)();
        nm = new Float32Array(9);
        blendMode = -1;
        camPos = [0, 0, 0];
        drawCalls = 0;
        isMobile;
        constructor(canvas) {
            this.canvas = canvas;
            this.isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
            canvas.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                this.contextLost = true;
            });
            canvas.addEventListener('webglcontextrestored', () => {
                this.initGL();
                this.contextLost = false;
                this.resize();
                this.onContextRestored?.();
            });
            this.initGL();
        }
        initGL() {
            const gl = this.canvas.getContext('webgl2', {
                antialias: !this.isMobile,
                alpha: false,
                powerPreference: 'high-performance',
                preserveDrawingBuffer: false,
            });
            if (!gl)
                throw new Error('WebGL2 is not available in this browser. Try a recent Chrome, Edge, Firefox or Safari.');
            this.gl = gl;
            this.prog = link(gl, VERT, FRAG);
            this.u = locations(gl, this.prog, [
                'uViewProj', 'uModel', 'uNormalMat', 'uColor', 'uColor2', 'uEmissive', 'uRimColor', 'uSunDir', 'uSunColor',
                'uSkyAmb', 'uGroundAmb', 'uCamPos', 'uFogColor', 'uFogDensity', 'uAlpha', 'uFlash', 'uRim', 'uSpec', 'uMode',
                'uArenaR', 'uTime', 'uTheme',
            ]);
            this.skyProg = link(gl, SKY_VERT, SKY_FRAG);
            this.skyU = locations(gl, this.skyProg, ['uRight', 'uUp', 'uFwd', 'uTop', 'uHor', 'uSunDir', 'uSunColor', 'uTan', 'uAspect', 'uStars', 'uTime']);
            const vao = gl.createVertexArray();
            if (!vao)
                throw new Error('Could not create VAO');
            this.skyVao = vao;
            this.meshes = buildMeshes(gl);
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.disable(gl.CULL_FACE);
            this.blendMode = -1;
        }
        setQuality(q) {
            this.quality = q;
            this.resize();
        }
        /** Render-resolution scale: lower on weak devices. */
        pixelRatio() {
            const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
            const cap = this.quality === 'high' ? 2 : this.quality === 'medium' ? 1.25 : 0.75;
            let r = Math.min(dpr, cap);
            // Never exceed ~2.1M pixels on low / ~3.7M on medium: keeps phones smooth.
            const maxPixels = this.quality === 'high' ? 6e6 : this.quality === 'medium' ? 3.0e6 : 1.4e6;
            const cssW = this.canvas.clientWidth || 1;
            const cssH = this.canvas.clientHeight || 1;
            while (cssW * cssH * r * r > maxPixels && r > 0.4)
                r *= 0.9;
            return r;
        }
        resize() {
            const r = this.pixelRatio();
            const w = Math.max(2, Math.floor((this.canvas.clientWidth || window.innerWidth) * r));
            const h = Math.max(2, Math.floor((this.canvas.clientHeight || window.innerHeight) * r));
            if (w !== this.canvas.width || h !== this.canvas.height) {
                this.canvas.width = w;
                this.canvas.height = h;
            }
            this.width = w;
            this.height = h;
            this.aspect = w / h;
            this.gl.viewport(0, 0, w, h);
        }
        beginFrame(cam, env, time) {
            const gl = this.gl;
            this.time = time;
            this.drawCalls = 0;
            this.camPos[0] = cam.eye[0];
            this.camPos[1] = cam.eye[1];
            this.camPos[2] = cam.eye[2];
            // Camera roll via rotating the up vector.
            const ux = Math.sin(cam.roll), uy = Math.cos(cam.roll);
            (0, math_js_6.m4LookAt)(this.view, cam.eye[0], cam.eye[1], cam.eye[2], cam.target[0], cam.target[1], cam.target[2], ux, uy, 0);
            this.fovy = cam.fov;
            (0, math_js_6.m4Perspective)(this.proj, cam.fov, this.aspect, 0.5, 700);
            (0, math_js_6.m4Mul)(this.viewProj, this.proj, this.view);
            gl.viewport(0, 0, this.width, this.height);
            gl.depthMask(true);
            gl.disable(gl.BLEND);
            this.blendMode = 0;
            gl.clearColor(env.fog[0], env.fog[1], env.fog[2], 1);
            gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
            this.drawSky(cam, env);
            gl.useProgram(this.prog);
            const u = this.u;
            gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
            gl.uniform3fv(u.uCamPos, this.camPos);
            gl.uniform3f(u.uSunDir, env.sunDir[0], env.sunDir[1], env.sunDir[2]);
            gl.uniform3f(u.uSunColor, env.sunColor[0], env.sunColor[1], env.sunColor[2]);
            gl.uniform3f(u.uSkyAmb, env.skyAmbient[0], env.skyAmbient[1], env.skyAmbient[2]);
            gl.uniform3f(u.uGroundAmb, env.groundAmbient[0], env.groundAmbient[1], env.groundAmbient[2]);
            gl.uniform3f(u.uFogColor, env.fog[0], env.fog[1], env.fog[2]);
            gl.uniform1f(u.uFogDensity, env.fogDensity);
            gl.uniform1f(u.uArenaR, env.arenaRadius);
            gl.uniform1f(u.uTime, time);
            gl.uniform1f(u.uTheme, env.theme);
        }
        drawSky(cam, env) {
            const gl = this.gl;
            let fx = cam.target[0] - cam.eye[0], fy = cam.target[1] - cam.eye[1], fz = cam.target[2] - cam.eye[2];
            const fl = Math.hypot(fx, fy, fz) || 1;
            fx /= fl;
            fy /= fl;
            fz /= fl;
            const ux = Math.sin(cam.roll), uy = Math.cos(cam.roll);
            // right = f x up
            let rx = fy * 0 - fz * uy, ry = fz * ux - fx * 0, rz = fx * uy - fy * ux;
            const rl = Math.hypot(rx, ry, rz) || 1;
            rx /= rl;
            ry /= rl;
            rz /= rl;
            const upx = ry * fz - rz * fy, upy = rz * fx - rx * fz, upz = rx * fy - ry * fx;
            gl.useProgram(this.skyProg);
            gl.depthMask(false);
            gl.disable(gl.DEPTH_TEST);
            const s = this.skyU;
            gl.uniform3f(s.uRight, rx, ry, rz);
            gl.uniform3f(s.uUp, upx, upy, upz);
            gl.uniform3f(s.uFwd, fx, fy, fz);
            gl.uniform3f(s.uTop, env.skyTop[0], env.skyTop[1], env.skyTop[2]);
            gl.uniform3f(s.uHor, env.skyHorizon[0], env.skyHorizon[1], env.skyHorizon[2]);
            gl.uniform3f(s.uSunDir, env.sunDir[0], env.sunDir[1], env.sunDir[2]);
            gl.uniform3f(s.uSunColor, env.sunColor[0], env.sunColor[1], env.sunColor[2]);
            gl.uniform1f(s.uTan, Math.tan(cam.fov / 2));
            gl.uniform1f(s.uAspect, this.aspect);
            gl.uniform1f(s.uStars, env.stars);
            gl.uniform1f(s.uTime, this.time);
            gl.bindVertexArray(this.skyVao);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            gl.enable(gl.DEPTH_TEST);
            gl.depthMask(true);
        }
        /** 0 opaque, 1 alpha, 2 additive */
        setBlend(mode) {
            if (mode === this.blendMode)
                return;
            const gl = this.gl;
            this.blendMode = mode;
            if (mode === 0) {
                gl.disable(gl.BLEND);
                gl.depthMask(true);
            }
            else if (mode === 1) {
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                gl.depthMask(false);
            }
            else {
                gl.enable(gl.BLEND);
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
                gl.depthMask(false);
            }
        }
        draw(mesh, model, m) {
            const gl = this.gl;
            const u = this.u;
            this.setBlend(m.additive ? 2 : m.alpha < 0.999 ? 1 : 0);
            gl.uniformMatrix4fv(u.uModel, false, model);
            gl.uniformMatrix3fv(u.uNormalMat, false, (0, math_js_6.m4NormalMat3)(this.nm, model));
            gl.uniform3fv(u.uColor, m.color);
            gl.uniform3fv(u.uColor2, m.color2);
            gl.uniform3fv(u.uEmissive, m.emissive);
            gl.uniform3fv(u.uRimColor, m.rimColor);
            gl.uniform1f(u.uAlpha, m.alpha);
            gl.uniform1f(u.uFlash, m.flash);
            gl.uniform1f(u.uRim, m.rim);
            gl.uniform1f(u.uSpec, m.spec);
            gl.uniform1f(u.uMode, m.mode);
            gl.bindVertexArray(mesh.vao);
            gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
            this.drawCalls++;
        }
        limbMesh(ratio) {
            const key = Math.round(ratio * 20) / 20;
            let m = this.meshes.limb.get(key);
            if (!m) {
                m = uploadMesh(this.gl, buildLathe(16, 0, 1, -1, key, true));
                this.meshes.limb.set(key, m);
            }
            return m;
        }
        /** Project a world point to canvas CSS pixels (for DOM overlays). Returns null when behind the camera. */
        project(x, y, z) {
            const m = this.viewProj;
            const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
            const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
            const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
            if (cw <= 0.01)
                return null;
            return {
                x: (cx / cw * 0.5 + 0.5) * this.canvas.clientWidth,
                y: (1 - (cy / cw * 0.5 + 0.5)) * this.canvas.clientHeight,
            };
        }
    }
    exports.Renderer = Renderer;
    function uploadMesh(gl, g) {
        const vao = gl.createVertexArray();
        const vb = gl.createBuffer();
        const ib = gl.createBuffer();
        if (!vao || !vb || !ib)
            throw new Error('Could not allocate mesh buffers');
        const n = g.pos.length / 3;
        const inter = new Float32Array(n * 6);
        for (let i = 0; i < n; i++) {
            inter[i * 6] = g.pos[i * 3];
            inter[i * 6 + 1] = g.pos[i * 3 + 1];
            inter[i * 6 + 2] = g.pos[i * 3 + 2];
            inter[i * 6 + 3] = g.nor[i * 3];
            inter[i * 6 + 4] = g.nor[i * 3 + 1];
            inter[i * 6 + 5] = g.nor[i * 3 + 2];
        }
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, vb);
        gl.bufferData(gl.ARRAY_BUFFER, inter, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(g.idx), gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        return { vao, count: g.idx.length };
    }
    function buildCube() {
        const pos = [];
        const nor = [];
        const idx = [];
        const faces = [
            [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
            [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
            [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
            [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
            [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
            [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
        ];
        for (const [n, verts] of faces) {
            const base = pos.length / 3;
            for (const v of verts) {
                pos.push(v[0] * 0.5, v[1] * 0.5, v[2] * 0.5);
                nor.push(n[0], n[1], n[2]);
            }
            idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
        return { pos, nor, idx };
    }
    function buildSphere(lat, lon) {
        const pos = [];
        const nor = [];
        const idx = [];
        for (let i = 0; i <= lat; i++) {
            const th = (i / lat) * Math.PI;
            for (let j = 0; j <= lon; j++) {
                const ph = (j / lon) * Math.PI * 2;
                const x = Math.sin(th) * Math.cos(ph);
                const y = Math.cos(th);
                const z = Math.sin(th) * Math.sin(ph);
                pos.push(x, y, z);
                nor.push(x, y, z);
            }
        }
        for (let i = 0; i < lat; i++) {
            for (let j = 0; j < lon; j++) {
                const a = i * (lon + 1) + j;
                const b = a + lon + 1;
                idx.push(a, b, a + 1, b, b + 1, a + 1);
            }
        }
        return { pos, nor, idx };
    }
    /** Lathe a (yTop, rTop) -> (yBottom, rBottom) profile around Y. */
    function buildLathe(seg, yTop, rTop, yBot, rBot, caps) {
        const pos = [];
        const nor = [];
        const idx = [];
        const dr = rBot - rTop;
        const dy = yBot - yTop;
        let nr = -dy;
        let ny = dr;
        const nl = Math.hypot(nr, ny) || 1;
        nr /= nl;
        ny /= nl;
        for (let j = 0; j <= seg; j++) {
            const a = (j / seg) * Math.PI * 2;
            const c = Math.cos(a), s = Math.sin(a);
            pos.push(c * rTop, yTop, s * rTop);
            nor.push(c * nr, ny, s * nr);
            pos.push(c * rBot, yBot, s * rBot);
            nor.push(c * nr, ny, s * nr);
        }
        for (let j = 0; j < seg; j++) {
            const a = j * 2;
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
        if (caps) {
            const addCap = (y, r, up) => {
                const base = pos.length / 3;
                pos.push(0, y, 0);
                nor.push(0, up, 0);
                for (let j = 0; j <= seg; j++) {
                    const a = (j / seg) * Math.PI * 2;
                    pos.push(Math.cos(a) * r, y, Math.sin(a) * r);
                    nor.push(0, up, 0);
                }
                for (let j = 0; j < seg; j++)
                    idx.push(base, base + 1 + j, base + 2 + j);
            };
            if (rTop > 0)
                addCap(yTop, rTop, 1);
            if (rBot > 0)
                addCap(yBot, rBot, -1);
        }
        return { pos, nor, idx };
    }
    function buildDisc(seg) {
        const pos = [0, 0, 0];
        const nor = [0, 1, 0];
        const idx = [];
        for (let j = 0; j <= seg; j++) {
            const a = (j / seg) * Math.PI * 2;
            pos.push(Math.cos(a), 0, Math.sin(a));
            nor.push(0, 1, 0);
        }
        for (let j = 0; j < seg; j++)
            idx.push(0, j + 2, j + 1);
        return { pos, nor, idx };
    }
    function buildRing(seg, inner) {
        const pos = [];
        const nor = [];
        const idx = [];
        for (let j = 0; j <= seg; j++) {
            const a = (j / seg) * Math.PI * 2;
            const c = Math.cos(a), s = Math.sin(a);
            pos.push(c, 0, s);
            nor.push(0, 1, 0);
            pos.push(c * inner, 0, s * inner);
            nor.push(0, 1, 0);
        }
        for (let j = 0; j < seg; j++) {
            const a = j * 2;
            idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
        }
        return { pos, nor, idx };
    }
    function buildMeshes(gl) {
        return {
            cube: uploadMesh(gl, buildCube()),
            sphere: uploadMesh(gl, buildSphere(12, 18)),
            cone: uploadMesh(gl, buildLathe(16, 1, 0, 0, 1, true)),
            disc: uploadMesh(gl, buildDisc(64)),
            ring: uploadMesh(gl, buildRing(48, 0.82)),
            beam: uploadMesh(gl, buildLathe(14, 1, 1, 0, 1, true)),
            limb: new Map(),
        };
    }
});
define("app/SaveManager", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.SaveManager = exports.DEFAULT_TOUCH_MAP = exports.DEFAULT_KEYS = exports.BINDABLE = exports.TOUCH_BUTTONS = exports.SAVE_VERSION = void 0;
    exports.defaultSettings = defaultSettings;
    exports.defaultRecords = defaultRecords;
    exports.sanitizeSettings = sanitizeSettings;
    exports.sanitizeRecords = sanitizeRecords;
    exports.SAVE_VERSION = 1;
    const KEY = 'ufe-ultimate-save';
    exports.TOUCH_BUTTONS = ['square', 'triangle', 'cross', 'circle', 'l1', 'r1', 'l2', 'r2', 'form', 'ult'];
    /** Actions that can be bound to buttons (pause is fixed to START / Escape). */
    exports.BINDABLE = ['light', 'heavy', 'special', 'beam', 'guard', 'jump', 'dodge', 'grab', 'alt', 'ultimate'];
    exports.DEFAULT_KEYS = {
        up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
        light: 'KeyJ', heavy: 'KeyK', special: 'KeyL', beam: 'KeyH',
        guard: 'KeyI', jump: 'Space', dodge: 'ShiftLeft', grab: 'KeyU', alt: 'KeyO', ultimate: 'KeyY',
    };
    exports.DEFAULT_TOUCH_MAP = {
        square: 'light', circle: 'heavy', cross: 'jump', triangle: 'special',
        l1: 'guard', r1: 'grab', l2: 'dodge', r2: 'beam', form: 'alt', ult: 'ultimate',
    };
    function defaultSettings() {
        return {
            master: 0.8, music: 0.5, sfx: 0.9, quality: 'auto', shake: true, difficulty: 'normal',
            rounds: 3, matchTime: 99, touch: 'auto', touchOpacity: 0.75, touchScale: 1, leftHanded: false,
            stickDeadzone: 0.18, stickSensitivity: 1, keys: { ...exports.DEFAULT_KEYS }, touchMap: { ...exports.DEFAULT_TOUCH_MAP },
        };
    }
    function defaultRecords() {
        return { wins: 0, losses: 0, streak: 0, bestStreak: 0, battleBest: 0, history: [] };
    }
    const num = (v, lo, hi, d) => typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
    const oneOf = (v, allowed, d) => allowed.includes(v) ? v : d;
    /** Merge arbitrary parsed JSON over defaults, dropping anything invalid. Never throws. */
    function sanitizeSettings(raw) {
        const d = defaultSettings();
        if (!raw || typeof raw !== 'object')
            return d;
        const r = raw;
        const s = {
            master: num(r.master, 0, 1, d.master),
            music: num(r.music, 0, 1, d.music),
            sfx: num(r.sfx, 0, 1, d.sfx),
            quality: oneOf(r.quality, ['auto', 'low', 'medium', 'high'], d.quality),
            shake: typeof r.shake === 'boolean' ? r.shake : d.shake,
            difficulty: oneOf(r.difficulty, ['easy', 'normal', 'hard'], d.difficulty),
            rounds: oneOf(r.rounds, [1, 3, 5], d.rounds),
            matchTime: oneOf(r.matchTime, [0, 60, 99], d.matchTime),
            touch: oneOf(r.touch, ['auto', 'on', 'off'], d.touch),
            touchOpacity: num(r.touchOpacity, 0.2, 1, d.touchOpacity),
            touchScale: num(r.touchScale, 0.7, 1.5, d.touchScale),
            leftHanded: typeof r.leftHanded === 'boolean' ? r.leftHanded : d.leftHanded,
            stickDeadzone: num(r.stickDeadzone, 0, 0.6, d.stickDeadzone),
            stickSensitivity: num(r.stickSensitivity, 0.5, 2, d.stickSensitivity),
            keys: { ...d.keys },
            touchMap: { ...d.touchMap },
        };
        if (r.keys && typeof r.keys === 'object') {
            for (const k of Object.keys(d.keys)) {
                const v = r.keys[k];
                if (typeof v === 'string' && v.length > 0 && v.length < 24)
                    s.keys[k] = v;
            }
        }
        if (r.touchMap && typeof r.touchMap === 'object') {
            for (const b of exports.TOUCH_BUTTONS) {
                const v = r.touchMap[b];
                if (typeof v === 'string' && exports.BINDABLE.includes(v))
                    s.touchMap[b] = v;
            }
        }
        return s;
    }
    function sanitizeRecords(raw) {
        const d = defaultRecords();
        if (!raw || typeof raw !== 'object')
            return d;
        const r = raw;
        const history = [];
        if (Array.isArray(r.history)) {
            for (const h of r.history.slice(0, 50)) {
                if (!h || typeof h !== 'object')
                    continue;
                const x = h;
                if (typeof x.p1 !== 'string' || typeof x.p2 !== 'string')
                    continue;
                history.push({
                    at: num(x.at, 0, 1e15, 0),
                    mode: typeof x.mode === 'string' ? x.mode.slice(0, 24) : '?',
                    p1: x.p1.slice(0, 32), p2: x.p2.slice(0, 32),
                    stage: typeof x.stage === 'string' ? x.stage.slice(0, 32) : '?',
                    winner: oneOf(x.winner, ['p1', 'p2', 'draw'], 'draw'),
                    rounds: typeof x.rounds === 'string' ? x.rounds.slice(0, 12) : '',
                    seconds: num(x.seconds, 0, 99999, 0),
                    rank: typeof x.rank === 'string' ? x.rank.slice(0, 2) : undefined,
                });
            }
        }
        return {
            wins: num(r.wins, 0, 1e9, 0), losses: num(r.losses, 0, 1e9, 0),
            streak: num(r.streak, 0, 1e9, 0), bestStreak: num(r.bestStreak, 0, 1e9, 0),
            battleBest: num(r.battleBest, 0, 5, 0), history,
        };
    }
    /** Local persistence. Storage may be unavailable (private mode, blocked) - everything degrades to in-memory. */
    class SaveManager {
        storage;
        data;
        /** Set when stored data was unreadable and defaults were used instead. */
        recovered = false;
        storageOk = true;
        constructor(storage = SaveManager.defaultStorage()) {
            this.storage = storage;
            this.data = this.load();
        }
        static defaultStorage() {
            try {
                return typeof localStorage === 'undefined' ? null : localStorage;
            }
            catch {
                return null;
            }
        }
        fresh() {
            return { version: exports.SAVE_VERSION, settings: defaultSettings(), records: defaultRecords() };
        }
        load() {
            if (!this.storage) {
                this.storageOk = false;
                return this.fresh();
            }
            let text = null;
            try {
                text = this.storage.getItem(KEY);
            }
            catch {
                this.storageOk = false;
                return this.fresh();
            }
            if (!text)
                return this.fresh();
            try {
                const parsed = JSON.parse(text);
                if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number' || parsed.version > exports.SAVE_VERSION) {
                    throw new Error('unsupported save');
                }
                // Version 1 is the only schema so far; future migrations would branch on parsed.version here.
                return {
                    version: exports.SAVE_VERSION,
                    settings: sanitizeSettings(parsed.settings),
                    records: sanitizeRecords(parsed.records),
                };
            }
            catch {
                this.recovered = true;
                return this.fresh();
            }
        }
        save() {
            if (!this.storage)
                return;
            try {
                this.storage.setItem(KEY, JSON.stringify(this.data));
            }
            catch {
                this.storageOk = false;
            }
        }
        get settings() {
            return this.data.settings;
        }
        get records() {
            return this.data.records;
        }
        addMatch(rec) {
            const r = this.data.records;
            r.history.unshift(rec);
            if (r.history.length > 50)
                r.history.length = 50;
            if (rec.mode !== 'practice' && rec.mode !== 'vs-2p') {
                if (rec.winner === 'p1') {
                    r.wins++;
                    r.streak++;
                    r.bestStreak = Math.max(r.bestStreak, r.streak);
                }
                else if (rec.winner === 'p2') {
                    r.losses++;
                    r.streak = 0;
                }
            }
            this.save();
        }
        reset() {
            this.data = this.fresh();
            try {
                this.storage?.removeItem(KEY);
            }
            catch {
                /* ignore */
            }
        }
    }
    exports.SaveManager = SaveManager;
});
define("input/TouchPad", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TouchPad = void 0;
    /**
     * On-screen PS2-style controller. Logic is independent per finger:
     *  - the stick tracks exactly one pointer,
     *  - every face / shoulder button tracks its own pointer (captured), so lifting one finger never affects another.
     * Held state is derived from the set of currently-down pointers, never from toggles, so nothing can stay stuck.
     */
    class TouchPad {
        getSettings;
        onStart;
        root;
        stickBase = null;
        stickThumb = null;
        stickPointer = -1;
        stickX = 0;
        stickY = 0;
        /** pointerId -> button id */
        pointers = new Map();
        pressedLatch = new Set();
        active = false;
        enabledByUser = false;
        lastUsed = 0;
        constructor(root, getSettings, onStart) {
            this.getSettings = getSettings;
            this.onStart = onStart;
            this.root = root;
            if (!root)
                return;
            this.stickBase = root.querySelector('#stick-base');
            this.stickThumb = root.querySelector('#stick-thumb');
            this.bind();
            this.applySettings();
        }
        /** True when the device primarily uses touch. */
        static isTouchDevice() {
            if (typeof window === 'undefined')
                return false;
            const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
            return coarse || 'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
        }
        get visible() {
            const mode = this.getSettings().touch;
            return mode === 'on' || (mode === 'auto' && TouchPad.isTouchDevice()) || this.enabledByUser;
        }
        /** Update visibility, scale, opacity and handedness from settings. `inBattle` hides the pad in menus. */
        applySettings(inBattle = true) {
            const root = this.root;
            if (!root)
                return;
            const s = this.getSettings();
            const show = this.visible && inBattle;
            root.classList.toggle('hidden', !show);
            root.classList.toggle('left-handed', s.leftHanded);
            root.style.setProperty('--pad-opacity', String(s.touchOpacity));
            root.style.setProperty('--pad-scale', String(s.touchScale));
            if (!show)
                this.releaseAll();
            this.active = show;
        }
        setUserEnabled(on) {
            this.enabledByUser = on;
        }
        bind() {
            const root = this.root;
            if (!root)
                return;
            // Prevent scrolling / zoom / text selection / context menu over the controller.
            for (const type of ['touchstart', 'touchmove', 'gesturestart', 'contextmenu']) {
                root.addEventListener(type, (e) => e.preventDefault(), { passive: false });
            }
            const base = this.stickBase;
            if (base) {
                base.addEventListener('pointerdown', (e) => {
                    if (this.stickPointer !== -1)
                        return;
                    e.preventDefault();
                    this.stickPointer = e.pointerId;
                    try {
                        base.setPointerCapture(e.pointerId);
                    }
                    catch { /* not capturable */ }
                    this.moveStick(e);
                });
                base.addEventListener('pointermove', (e) => {
                    if (e.pointerId === this.stickPointer)
                        this.moveStick(e);
                });
                const end = (e) => {
                    if (e.pointerId !== this.stickPointer)
                        return;
                    this.stickPointer = -1;
                    this.stickX = 0;
                    this.stickY = 0;
                    this.drawThumb();
                };
                base.addEventListener('pointerup', end);
                base.addEventListener('pointercancel', end);
                base.addEventListener('lostpointercapture', end);
            }
            root.querySelectorAll('[data-btn]').forEach((el) => {
                const id = el.dataset.btn;
                el.addEventListener('pointerdown', (e) => {
                    e.preventDefault();
                    if (id === 'start') {
                        this.onStart();
                        el.classList.add('down');
                        return;
                    }
                    if (id === 'select') {
                        document.dispatchEvent(new CustomEvent('ufe-select-panel'));
                        el.classList.add('down');
                        return;
                    }
                    try {
                        el.setPointerCapture(e.pointerId);
                    }
                    catch { /* not capturable */ }
                    this.pointers.set(e.pointerId, id);
                    this.pressedLatch.add(id);
                    el.classList.add('down');
                });
                const up = (e) => {
                    el.classList.remove('down');
                    this.pointers.delete(e.pointerId);
                };
                el.addEventListener('pointerup', up);
                el.addEventListener('pointercancel', up);
                el.addEventListener('lostpointercapture', up);
            });
        }
        moveStick(e) {
            const base = this.stickBase;
            if (!base)
                return;
            const r = base.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const radius = r.width / 2;
            let dx = (e.clientX - cx) / radius;
            let dy = (e.clientY - cy) / radius;
            const len = Math.hypot(dx, dy);
            if (len > 1) {
                dx /= len;
                dy /= len;
            }
            const s = this.getSettings();
            const mag = Math.min(1, Math.hypot(dx, dy));
            if (mag < s.stickDeadzone) {
                this.stickX = 0;
                this.stickY = 0;
            }
            else {
                const k = Math.min(1, ((mag - s.stickDeadzone) / (1 - s.stickDeadzone)) * s.stickSensitivity) / mag;
                this.stickX = dx * k;
                this.stickY = -dy * k;
            }
            this.drawThumb(dx, dy);
        }
        drawThumb(dx = 0, dy = 0) {
            if (!this.stickThumb)
                return;
            this.stickThumb.style.transform = `translate(calc(-50% + ${dx * 36}%), calc(-50% + ${dy * 36}%))`;
        }
        /** Remove every held touch input (rotation, focus loss, menu opened). */
        releaseAll() {
            this.pointers.clear();
            this.pressedLatch.clear();
            this.stickPointer = -1;
            this.stickX = 0;
            this.stickY = 0;
            this.drawThumb();
            this.root?.querySelectorAll('.down').forEach((el) => el.classList.remove('down'));
        }
        flush() {
            this.pressedLatch.clear();
        }
        /** Merge the pad state into `frame`. Returns true when the pad is contributing input. */
        sample(frame) {
            if (!this.active)
                return false;
            const map = this.getSettings().touchMap;
            let used = false;
            if (this.stickX !== 0 || this.stickY !== 0) {
                frame.moveX += this.stickX;
                frame.moveY += this.stickY;
                used = true;
            }
            for (const id of this.pointers.values()) {
                const a = map[id];
                frame.held[a] = true;
                used = true;
            }
            for (const id of this.pressedLatch) {
                const a = map[id];
                frame.pressed[a] = true;
                frame.held[a] = true;
                used = true;
            }
            if (used)
                this.lastUsed = performance.now();
            return used;
        }
        get recentlyUsed() {
            return performance.now() - this.lastUsed < 3000;
        }
        /** Test hooks: drive the pad without DOM events. */
        debugSet(stickX, stickY, buttons) {
            this.active = true;
            this.stickX = stickX;
            this.stickY = stickY;
            this.pointers.clear();
            buttons.forEach((b, i) => {
                this.pointers.set(1000 + i, b);
                this.pressedLatch.add(b);
            });
        }
        dispose() {
            this.releaseAll();
        }
    }
    exports.TouchPad = TouchPad;
});
define("input/InputManager", ["require", "exports", "combat/types", "input/TouchPad"], function (require, exports, types_js_3, TouchPad_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.InputManager = exports.P2_KEYS = void 0;
    exports.keyLabel = keyLabel;
    exports.P2_KEYS = {
        up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
        light: 'Comma', heavy: 'Period', special: 'Slash', beam: 'Semicolon',
        guard: 'Quote', jump: 'ShiftRight', dodge: 'Enter', grab: 'BracketRight', alt: 'Backslash', ultimate: 'BracketLeft',
    };
    /** Standard-mapping gamepad -> actions (PS-style names in comments; Xbox in brackets). */
    const PAD_BUTTONS = {
        2: 'light', // square [X]
        1: 'heavy', // circle [B]
        0: 'jump', // cross [A]
        3: 'special', // triangle [Y]
        4: 'guard', // L1 [LB]
        5: 'grab', // R1 [RB]
        6: 'dodge', // L2 [LT]
        7: 'beam', // R2 [RT]
        8: 'alt', // select / back [View] - transform
        11: 'ultimate', // right stick click [R3] - ultimate
    };
    const PAD_DEADZONE = 0.22;
    /**
     * One abstraction for every input source. Each call to `sample(player)` returns the same `InputFrame` the AI
     * produces, so combat code never knows (or cares) whether a finger, key, pad or CPU is driving a fighter.
     */
    class InputManager {
        getSettings;
        touch;
        /** Player keyboard state (by KeyboardEvent.code). */
        down = new Set();
        latched = new Set();
        padMem = new Map();
        pausePressed = false;
        lastDevice = 'keyboard';
        /** Fires when a pad disconnects (game should pause). */
        onPadDisconnected = null;
        onPadConnected = null;
        /** Fires on Escape / START. */
        onPause = null;
        /** Fires on any key press while `captureNext` is set (used for remapping). */
        capture = null;
        p2Enabled = false;
        pausePadHeld = false;
        constructor(getSettings, touchRoot) {
            this.getSettings = getSettings;
            this.touch = new TouchPad_js_1.TouchPad(touchRoot, getSettings, () => this.onPause?.());
            window.addEventListener('keydown', this.onKeyDown);
            window.addEventListener('keyup', this.onKeyUp);
            window.addEventListener('blur', this.releaseAll);
            document.addEventListener('visibilitychange', () => {
                if (document.hidden)
                    this.releaseAll();
            });
            window.addEventListener('orientationchange', this.releaseAll);
            window.addEventListener('gamepaddisconnected', () => this.onPadDisconnected?.());
            window.addEventListener('gamepadconnected', (e) => this.onPadConnected?.(e.gamepad.id));
        }
        get device() {
            return this.lastDevice;
        }
        /** Ask for the next key press (remapping UI). */
        captureNextKey(cb) {
            this.capture = cb;
        }
        cancelCapture() {
            this.capture = null;
        }
        onKeyDown = (e) => {
            if (this.capture) {
                e.preventDefault();
                const cb = this.capture;
                this.capture = null;
                if (e.code !== 'Escape')
                    cb(e.code);
                else
                    cb('');
                return;
            }
            const target = e.target;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA'))
                return;
            if (e.code === 'Escape' || e.code === 'KeyP') {
                if (!e.repeat)
                    this.onPause?.();
                return;
            }
            // Stop the page from scrolling / activating focused buttons with Space during play.
            if (e.code === 'Space' || e.code.startsWith('Arrow'))
                e.preventDefault();
            this.lastDevice = 'keyboard';
            if (!this.down.has(e.code))
                this.latched.add(e.code);
            this.down.add(e.code);
        };
        onKeyUp = (e) => {
            this.down.delete(e.code);
        };
        /** Drop every held input (focus loss, rotation, pausing): nothing may stay stuck. */
        releaseAll = () => {
            this.down.clear();
            this.latched.clear();
            this.touch.releaseAll();
            this.padMem.clear();
        };
        /** Clear latched presses (e.g. when a new round starts) without clearing held keys. */
        flush() {
            this.latched.clear();
            this.touch.flush();
        }
        keyFrame(keys, frame) {
            let used = false;
            let mx = 0;
            let my = 0;
            if (this.down.has(keys.left))
                mx -= 1;
            if (this.down.has(keys.right))
                mx += 1;
            if (this.down.has(keys.up))
                my += 1;
            if (this.down.has(keys.down))
                my -= 1;
            if (mx !== 0 || my !== 0) {
                const len = Math.hypot(mx, my);
                frame.moveX += mx / len;
                frame.moveY += my / len;
                used = true;
            }
            for (const a of types_js_3.ACTIONS) {
                const code = keys[a];
                if (!code)
                    continue;
                if (this.down.has(code)) {
                    frame.held[a] = true;
                    used = true;
                }
                if (this.latched.has(code)) {
                    frame.pressed[a] = true;
                    frame.held[a] = true;
                    used = true;
                }
            }
            return used;
        }
        readPad(index, frame) {
            const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : [];
            const connected = [];
            for (const p of pads)
                if (p && p.connected)
                    connected.push(p);
            const pad = connected[index];
            if (!pad)
                return false;
            let used = false;
            let mem = this.padMem.get(pad.index);
            if (!mem) {
                mem = { held: new Set() };
                this.padMem.set(pad.index, mem);
            }
            let ax = pad.axes[0] ?? 0;
            let ay = -(pad.axes[1] ?? 0);
            const dpadX = (pad.buttons[15]?.pressed ? 1 : 0) - (pad.buttons[14]?.pressed ? 1 : 0);
            const dpadY = (pad.buttons[12]?.pressed ? 1 : 0) - (pad.buttons[13]?.pressed ? 1 : 0);
            if (dpadX !== 0 || dpadY !== 0) {
                ax = dpadX;
                ay = dpadY;
            }
            const mag = Math.hypot(ax, ay);
            if (mag > PAD_DEADZONE) {
                const k = Math.min(1, (mag - PAD_DEADZONE) / (1 - PAD_DEADZONE)) / mag;
                frame.moveX += ax * k;
                frame.moveY += ay * k;
                used = true;
            }
            for (const [idx, action] of Object.entries(PAD_BUTTONS)) {
                const i = Number(idx);
                const b = pad.buttons[i];
                const isDown = !!b && (b.pressed || b.value > 0.5);
                const was = mem.held.has(i);
                if (isDown) {
                    frame.held[action] = true;
                    used = true;
                    if (!was) {
                        frame.pressed[action] = true;
                        mem.held.add(i);
                    }
                }
                else if (was) {
                    mem.held.delete(i);
                }
            }
            if (index === 0) {
                const start = !!pad.buttons[9]?.pressed;
                if (start && !this.pausePadHeld)
                    this.onPause?.();
                this.pausePadHeld = start;
            }
            return used;
        }
        /** Produce the input frame for player `index` and consume latched presses for this tick. */
        sample(index) {
            const s = this.getSettings();
            const frame = { moveX: 0, moveY: 0, held: (0, types_js_3.emptyActions)(), pressed: (0, types_js_3.emptyActions)() };
            if (index === 0) {
                if (this.keyFrame(s.keys, frame))
                    this.lastDevice = 'keyboard';
                if (this.readPad(0, frame))
                    this.lastDevice = 'gamepad';
                const t = this.touch.sample(frame);
                if (t)
                    this.lastDevice = 'touch';
            }
            else if (this.p2Enabled) {
                this.keyFrame(exports.P2_KEYS, frame);
                this.readPad(1, frame);
            }
            const len = Math.hypot(frame.moveX, frame.moveY);
            if (len > 1) {
                frame.moveX /= len;
                frame.moveY /= len;
            }
            return frame;
        }
        /** Call once per simulation tick after sampling both players. */
        endTick() {
            this.latched.clear();
            this.touch.flush();
        }
        get pausedRequested() {
            return this.pausePressed;
        }
        dispose() {
            window.removeEventListener('keydown', this.onKeyDown);
            window.removeEventListener('keyup', this.onKeyUp);
            window.removeEventListener('blur', this.releaseAll);
            window.removeEventListener('orientationchange', this.releaseAll);
            this.touch.dispose();
        }
    }
    exports.InputManager = InputManager;
    function keyLabel(code) {
        if (!code)
            return '-';
        if (code.startsWith('Key'))
            return code.slice(3);
        if (code.startsWith('Digit'))
            return code.slice(5);
        const map = {
            Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
            ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Comma: ',', Period: '.', Slash: '/',
            Semicolon: ';', Quote: "'", BracketRight: ']', BracketLeft: '[', Enter: 'Enter', Backslash: '\\',
        };
        return map[code] ?? code;
    }
});
define("render/Camera", ["require", "exports", "math"], function (require, exports, math_js_7) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.FightCamera = exports.MAX_FOCUS_SECONDS = void 0;
    const BASE_FOV = 0.76;
    /** Widest field of view the framing guarantee may use. */
    const MAX_FOV = 1.25;
    /** Fraction of the half-screen both fighters must stay inside. */
    const FRAME_MARGIN = 0.92;
    /** A cinematic focus can never last longer than this, whatever the caller asks for. */
    exports.MAX_FOCUS_SECONDS = 3;
    /**
     * Third-person fighting camera. It always frames both combatants, eases (never snaps), keeps itself inside the
     * arena shell (so it can't clip scenery or the floor) and supports trauma-based shake with a reduction option.
     */
    class FightCamera {
        state = { eye: [0, 20, -50], target: [0, 5, 0], roll: 0, fov: BASE_FOV };
        mode = 'fight';
        /** 0..1 scale for shake (0 = disabled). */
        shakeScale = 1;
        yaw = 0;
        dist = 60;
        height = 14;
        trauma = 0;
        modeTime = 0;
        focusX = 0;
        focusZ = 0;
        focusY = 5;
        koFocus = 0;
        initialised = false;
        orbitAngle = 0;
        // Cinematic focus (ultimates / transformations). Time-limited by construction, so it can never stick.
        cineFighter = 0;
        cineClose = 0;
        cineLeft = 0;
        cineAmt = 0;
        addTrauma(amount) {
            this.trauma = Math.min(1, this.trauma + amount);
        }
        setMode(mode) {
            if (this.mode !== mode) {
                this.mode = mode;
                this.modeTime = 0;
            }
        }
        /** Push in on one fighter for `seconds` (clamped). The camera eases in and always eases back out. */
        focus(fighter, closeUp, seconds) {
            this.cineFighter = fighter === 1 ? 1 : 0;
            this.cineClose = (0, math_js_7.clamp)(closeUp, 0, 1);
            this.cineLeft = (0, math_js_7.clamp)(seconds, 0.1, exports.MAX_FOCUS_SECONDS);
        }
        /** Start easing back to the normal camera (safe to call at any time). */
        clearFocus() {
            this.cineLeft = 0;
        }
        /** True while the cinematic framing is active or still easing out. */
        get focusActive() {
            return this.cineLeft > 0 || this.cineAmt > 0.01;
        }
        setKoFocus(index) {
            this.koFocus = index;
        }
        /** Vertical field of view (radians) at which both fighters fit inside FRAME_MARGIN of the screen. */
        fovToFrame(battle, aspect, ex, ey, ez) {
            let fx = this.focusX - ex, fy = this.focusY - ey, fz = this.focusZ - ez;
            const fl = Math.hypot(fx, fy, fz) || 1;
            fx /= fl;
            fy /= fl;
            fz /= fl;
            // right = forward x worldUp (horizontal, unit length); cameraUp = right x forward (unit length)
            let rx = -fz, rz = fx;
            const rl = Math.hypot(rx, rz) || 1;
            rx /= rl;
            rz /= rl;
            const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
            let need = 0;
            for (const f of battle.fighters) {
                const cy = f.y + f.height * 0.5;
                const dx = f.x - ex, dy = cy - ey, dz = f.z - ez;
                const z = dx * fx + dy * fy + dz * fz;
                if (z < 1)
                    return MAX_FOV; // behind / on top of the camera: give up and show as much as possible
                const x = Math.abs(dx * rx + dz * rz) + f.radius;
                const y = Math.abs(dx * ux + dy * uy + dz * uz) + f.height * 0.35;
                need = Math.max(need, x / (z * Math.min(aspect, 4)), y / z);
            }
            return 2 * Math.atan(need / FRAME_MARGIN);
        }
        update(dt, battle, aspect, time) {
            this.modeTime += dt;
            const [a, b] = battle.fighters;
            const ax = a.x, az = a.z, bx = b.x, bz = b.z;
            const dx = bx - ax, dz = bz - az;
            const sep = Math.hypot(dx, dz);
            const lineYaw = Math.atan2(dx, dz);
            const R = battle.radius;
            let midX = (ax + bx) / 2;
            let midZ = (az + bz) / 2;
            let targetYaw = lineYaw + 0.5;
            const tanH = Math.tan(this.state.fov / 2);
            // Distance so both fighters (plus margin) fit horizontally AND the taller one fits vertically.
            const fitW = (sep / 2 + 11) / Math.max(0.35, tanH * Math.min(aspect, 2.2) * 0.92);
            const fitH = 19 / Math.max(0.2, tanH);
            let wantDist = (0, math_js_7.clamp)(Math.max(fitW, fitH * 0.62), 27, R + 24);
            let wantHeight = 5.5 + sep * 0.09;
            let focusY = 4.6 + Math.min(3, sep * 0.025);
            let rate = 3.2;
            if (this.mode === 'intro') {
                const u = (0, math_js_7.clamp)(this.modeTime / 2.2, 0, 1);
                wantDist *= 1.35 - 0.35 * u;
                wantHeight += 22 * (1 - u);
                targetYaw += (1 - u) * 1.1;
                rate = 2.2;
            }
            else if (this.mode === 'ko') {
                const loser = battle.fighters[this.koFocus];
                midX = loser.x * 0.7 + midX * 0.3;
                midZ = loser.z * 0.7 + midZ * 0.3;
                wantDist = 36;
                wantHeight = 8;
                focusY = 5;
                targetYaw += this.modeTime * 0.25;
                rate = 2.4;
            }
            else if (this.mode === 'victory') {
                const w = battle.fighters.find((f) => f.state === 'victory') ?? a;
                midX = w.x;
                midZ = w.z;
                wantDist = 34;
                wantHeight = 6;
                focusY = w.height * 0.62;
                targetYaw = this.orbitAngle + this.modeTime * 0.3;
                rate = 2;
            }
            else if (this.mode === 'orbit') {
                // Menu / character-select orbit around the two previews
                this.orbitAngle += dt * 0.25;
                targetYaw = this.orbitAngle * 0.3 + lineYaw + 0.4;
                wantDist = 54;
                wantHeight = 11;
            }
            // ---- cinematic focus: lean toward one fighter while keeping BOTH inside the frame at any aspect ratio
            if (this.cineLeft > 0)
                this.cineLeft = Math.max(0, this.cineLeft - dt);
            const wantAmt = this.cineLeft > 0 && this.mode === 'fight' ? this.cineClose : 0;
            this.cineAmt = (0, math_js_7.damp)(this.cineAmt, wantAmt, wantAmt > this.cineAmt ? 6 : 3.5, dt);
            if (wantAmt === 0 && this.cineAmt < 0.004)
                this.cineAmt = 0;
            if (this.cineAmt > 0) {
                const amt = this.cineAmt;
                const w = amt * 0.75;
                const cf = battle.fighters[this.cineFighter];
                midX = (0, math_js_7.lerp)(midX, cf.x, w);
                midZ = (0, math_js_7.lerp)(midZ, cf.z, w);
                const farOffset = (sep / 2) * (1 + w);
                const fitWc = (farOffset + 11) / Math.max(0.35, tanH * Math.min(aspect, 2.2) * 0.92);
                wantDist = (0, math_js_7.clamp)(Math.max(fitWc, fitH * 0.62 * (1 - 0.32 * amt), (0, math_js_7.lerp)(27, 20, amt)), 20, R + 24);
                wantHeight = (0, math_js_7.lerp)(wantHeight, cf.height * 0.55 + 2, amt * 0.6);
                focusY = (0, math_js_7.lerp)(focusY, cf.height * 0.6, amt * 0.8);
                targetYaw = lineYaw + (0, math_js_7.lerp)(0.5, (this.cineFighter === 0 ? 1 : -1) * 1.1, amt);
                rate = 3.6;
            }
            const wantFov = (0, math_js_7.lerp)(BASE_FOV, 0.64, this.cineAmt * 0.8);
            if (!this.initialised) {
                this.yaw = targetYaw;
                this.dist = wantDist;
                this.height = wantHeight;
                this.focusX = midX;
                this.focusZ = midZ;
                this.focusY = focusY;
                this.initialised = true;
            }
            this.yaw = (0, math_js_7.wrapAngle)(this.yaw + (0, math_js_7.angleDiff)(this.yaw, targetYaw) * (1 - Math.exp(-rate * dt)));
            this.dist = (0, math_js_7.damp)(this.dist, wantDist, rate, dt);
            this.height = (0, math_js_7.damp)(this.height, wantHeight, rate, dt);
            this.focusX = (0, math_js_7.damp)(this.focusX, midX, rate * 1.4, dt);
            this.focusZ = (0, math_js_7.damp)(this.focusZ, midZ, rate * 1.4, dt);
            this.focusY = (0, math_js_7.damp)(this.focusY, focusY, rate, dt);
            let ex = this.focusX - Math.sin(this.yaw) * this.dist;
            let ez = this.focusZ - Math.cos(this.yaw) * this.dist;
            let ey = this.height;
            // Keep the camera inside the arena shell and above the floor (no clipping through scenery or ground).
            const limit = R + 6;
            const er = Math.hypot(ex, ez);
            if (er > limit) {
                ex *= limit / er;
                ez *= limit / er;
            }
            ey = Math.max(ey, 3);
            // Framing guarantee: whatever the mode, the arena shell or a close-up can prevent the camera from backing off
            // far enough. Measure both fighters from the FINAL eye position and widen the field of view just enough that
            // both stay on screen (never narrower than requested, never wider than MAX_FOV).
            const fovNeeded = this.fovToFrame(battle, aspect, ex, ey, ez);
            const targetFov = (0, math_js_7.clamp)(Math.max(wantFov, fovNeeded), 0.5, MAX_FOV);
            this.state.fov = (0, math_js_7.damp)(this.state.fov, targetFov, targetFov > this.state.fov ? 14 : 4, dt);
            if (targetFov > this.state.fov)
                this.state.fov = Math.max(this.state.fov, Math.min(targetFov, fovNeeded));
            if (Math.abs(this.state.fov - BASE_FOV) < 0.0005 && targetFov === BASE_FOV)
                this.state.fov = BASE_FOV;
            // Trauma shake
            this.trauma = Math.max(0, this.trauma - dt * 1.7);
            const amp = this.trauma * this.trauma * 1.5 * this.shakeScale;
            const sx = (Math.sin(time * 61.3) + Math.sin(time * 37.7 + 1.3)) * 0.5 * amp;
            const sy = (Math.sin(time * 53.1 + 2.1) + Math.sin(time * 41.9)) * 0.5 * amp;
            const roll = Math.sin(time * 47.0) * this.trauma * this.trauma * 0.015 * this.shakeScale;
            const s = this.state;
            s.eye[0] = ex + sx;
            s.eye[1] = ey + sy;
            s.eye[2] = ez;
            s.target[0] = this.focusX;
            s.target[1] = this.focusY;
            s.target[2] = this.focusZ;
            s.roll = roll;
        }
    }
    exports.FightCamera = FightCamera;
});
define("render/FighterModel", ["require", "exports", "math", "render/Renderer"], function (require, exports, math_js_8, Renderer_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.FighterAnimator = void 0;
    exports.fighterWorldPos = fighterWorldPos;
    exports.drawFighter = drawFighter;
    const KEYS = [
        'rootY', 'rootZ', 'rootPitch', 'rootRoll', 'torsoPitch', 'torsoYaw', 'headTilt', 'headYaw',
        'shL', 'shLr', 'elL', 'shR', 'shRr', 'elR', 'hipL', 'knL', 'hipR', 'knR', 'tail', 'jaw',
    ];
    const zeroPose = () => ({
        rootY: 0, rootZ: 0, rootPitch: 0, rootRoll: 0, torsoPitch: 0, torsoYaw: 0, headTilt: 0, headYaw: 0,
        shL: 0, shLr: 0, elL: 0, shR: 0, shRr: 0, elR: 0, hipL: 0, knL: 0, hipR: 0, knR: 0, tail: 0, jaw: 0,
    });
    function copyPose(dst, src) {
        for (const k of KEYS)
            dst[k] = src[k];
        return dst;
    }
    function patchPose(dst, patch) {
        for (const k of Object.keys(patch)) {
            const v = patch[k];
            if (v === undefined)
                continue;
            dst[k === 'tail' ? 'tail' : k] = v;
        }
    }
    function lerpPose(out, a, b, t) {
        for (const k of KEYS)
            out[k] = (0, math_js_8.lerp)(a[k], b[k], t);
        return out;
    }
    /** Holds the smoothed pose of one fighter and derives targets from its simulation state. */
    class FighterAnimator {
        pose = zeroPose();
        base = zeroPose();
        windup = zeroPose();
        strike = zeroPose();
        target = zeroPose();
        walkPhase = 0;
        initialised = false;
        update(f, dt, time) {
            this.computeTarget(f, time);
            const t = this.target;
            if (!this.initialised) {
                copyPose(this.pose, t);
                this.initialised = true;
                return;
            }
            let rate = 14;
            switch (f.state) {
                case 'attack':
                    rate = f.attackTime < (f.attack?.startup ?? 0) ? 30 : 48;
                    break;
                case 'hitstun':
                case 'blockstun':
                    rate = 34;
                    break;
                case 'beam':
                    rate = 30;
                    break;
                case 'launched':
                case 'down':
                case 'defeated':
                    rate = 11;
                    break;
                default: break;
            }
            for (const k of KEYS)
                this.pose[k] = (0, math_js_8.damp)(this.pose[k], t[k], rate, dt);
        }
        computeTarget(f, time) {
            const H = f.height;
            const rig = f.def.rig;
            const st = rig.stance;
            const b = this.base;
            const dt = 1 / 60;
            // ---- idle fighting stance (unique per character)
            b.rootY = 0;
            b.rootZ = 0;
            b.rootPitch = 0;
            b.rootRoll = 0;
            const breathe = Math.sin(time * (rig.style === 'speed' ? 5.5 : rig.style === 'kaiju' ? 1.5 : 2.4) + f.index);
            b.torsoPitch = st.lean + breathe * 0.02;
            b.torsoYaw = 0;
            b.headTilt = -st.lean * 0.6;
            b.headYaw = 0;
            const c = st.crouch;
            b.hipL = c * 1.1 + 0.12;
            b.hipR = c * 1.1 - 0.1;
            b.knL = c * 2.1 + 0.1;
            b.knR = c * 2.1 + 0.18;
            if (rig.style === 'kaiju') {
                b.hipL = c * 1.0;
                b.hipR = c * 1.0;
                b.knL = c * 1.8;
                b.knR = c * 1.8;
                b.shL = 0.45 + breathe * 0.04;
                b.shR = 0.45 - breathe * 0.04;
            }
            else {
                b.shL = 0.5 + breathe * 0.03;
                b.shR = 0.35 - breathe * 0.03;
            }
            b.shLr = st.armSpread * 0.55;
            b.shRr = st.armSpread * 0.55;
            b.elL = st.elbow;
            b.elR = st.elbow + 0.15;
            b.tail = Math.sin(time * 1.4) * 0.3;
            b.jaw = rig.style === 'kaiju' ? 0.12 + breathe * 0.04 : 0;
            if (rig.style === 'speed')
                b.rootY = Math.abs(Math.sin(time * 5.5)) * 0.012 * H;
            // ---- locomotion layered on idle
            if (f.state === 'walk' || f.state === 'idle' || f.state === 'guard' || f.state === 'dodge') {
                const speed = Math.hypot(f.vx, f.vz);
                if (speed > 0.4) {
                    const dir = Math.abs(f.localVx) >= Math.abs(f.localVz) ? Math.sign(f.localVx || 1) : 1;
                    this.walkPhase += dir * (speed * dt / (0.3 * H)) * Math.PI;
                    const amp = Math.min(0.75, 0.2 + f.walkSpeedFrac * 0.45);
                    const s = Math.sin(this.walkPhase);
                    const kneeL = Math.max(0, Math.sin(this.walkPhase + Math.PI / 2)) * amp * 1.3;
                    const kneeR = Math.max(0, Math.sin(this.walkPhase - Math.PI / 2)) * amp * 1.3;
                    b.hipL += s * amp;
                    b.hipR -= s * amp;
                    b.knL += kneeL;
                    b.knR += kneeR;
                    b.shL -= s * amp * 0.45;
                    b.shR += s * amp * 0.45;
                    b.rootY += Math.abs(Math.cos(this.walkPhase)) * 0.015 * H;
                    b.torsoYaw = s * 0.08;
                    b.rootRoll = (0, math_js_8.clamp)(f.localVz * 0.004, -0.12, 0.12);
                    b.tail += Math.sin(this.walkPhase) * 0.5;
                }
            }
            const t = this.target;
            copyPose(t, b);
            switch (f.state) {
                case 'guard': {
                    t.shL = 1.25;
                    t.shR = 1.25;
                    t.elL = 1.75;
                    t.elR = 1.75;
                    t.shLr = -0.15;
                    t.shRr = -0.15;
                    t.torsoPitch = 0.18 + st.lean;
                    t.headTilt = -0.15;
                    t.hipL += 0.15;
                    t.hipR += 0.1;
                    t.knL += 0.25;
                    t.knR += 0.25;
                    break;
                }
                case 'blockstun': {
                    t.shL = 1.35;
                    t.shR = 1.35;
                    t.elL = 1.85;
                    t.elR = 1.85;
                    t.torsoPitch = -0.05;
                    t.rootZ = -0.01 * H;
                    break;
                }
                case 'dodge': {
                    t.rootRoll = (0, math_js_8.clamp)(f.localVz * 0.012, -0.5, 0.5);
                    t.rootPitch = (0, math_js_8.clamp)(-f.localVx * 0.012, -0.5, 0.4);
                    t.torsoPitch += 0.2;
                    t.shL = 0.9;
                    t.shR = 0.9;
                    break;
                }
                case 'jump': {
                    t.hipL = 1.0;
                    t.knL = 1.5;
                    t.hipR = 0.1;
                    t.knR = 0.5;
                    t.shL = 1.9;
                    t.shR = 1.9;
                    t.elL = 0.6;
                    t.elR = 0.6;
                    t.shLr = 0.5;
                    t.shRr = 0.5;
                    t.torsoPitch = 0.1;
                    break;
                }
                case 'hitstun': {
                    t.torsoPitch = -0.38;
                    t.headTilt = -0.4;
                    t.shL = -0.5;
                    t.shR = -0.3;
                    t.elL = 0.6;
                    t.elR = 0.5;
                    t.shLr = 0.5;
                    t.shRr = 0.5;
                    t.hipL += 0.2;
                    t.knL += 0.3;
                    t.knR += 0.3;
                    t.rootZ = -0.02 * H;
                    break;
                }
                case 'launched': {
                    const rising = f.vy > 0;
                    t.rootPitch = rising ? -0.7 : -1.25;
                    t.shL = -1.0;
                    t.shR = -0.6;
                    t.shLr = 0.8;
                    t.shRr = 0.8;
                    t.elL = 0.4;
                    t.elR = 0.4;
                    t.hipL = 0.5;
                    t.knL = 0.5;
                    t.hipR = 0.1;
                    t.knR = 0.3;
                    t.headTilt = -0.4;
                    t.rootY = 0.04 * H;
                    t.torsoPitch = -0.1;
                    break;
                }
                case 'down':
                case 'defeated': {
                    t.rootPitch = -Math.PI / 2;
                    t.rootZ = 0.5 * H * 0.95;
                    t.rootY = 0.1 * H;
                    t.shL = 0.3;
                    t.shR = -0.1;
                    t.shLr = 0.9;
                    t.shRr = 0.9;
                    t.elL = 0.2;
                    t.elR = 0.2;
                    t.hipL = 0.1;
                    t.hipR = -0.05;
                    t.knL = 0.1;
                    t.knR = 0.2;
                    t.torsoPitch = 0;
                    t.headTilt = 0.1;
                    if (f.state === 'defeated') {
                        t.shL = 0.1;
                        t.shR = 0.1;
                        t.jaw = 0.5;
                    }
                    break;
                }
                case 'getup': {
                    const u = (0, math_js_8.clamp)(f.stateTime / 0.45, 0, 1);
                    t.rootPitch = (0, math_js_8.lerp)(-1.1, 0, (0, math_js_8.easeOutCubic)(u));
                    t.rootZ = (0, math_js_8.lerp)(0.3 * H, 0, (0, math_js_8.easeOutCubic)(u));
                    t.hipL += 0.5;
                    t.knL += 0.9;
                    t.hipR += 0.2;
                    t.knR += 0.5;
                    t.torsoPitch += 0.3;
                    break;
                }
                case 'charge': {
                    const beam = f.def.moves.beam;
                    const u = (0, math_js_8.clamp)(f.chargeTime / Math.max(0.01, beam.maxCharge), 0, 1);
                    patchPose(t, beam.windup);
                    t.hipL += 0.25;
                    t.hipR += 0.25;
                    t.knL += 0.5;
                    t.knR += 0.5;
                    t.shL += Math.sin(time * 28) * 0.03 * u;
                    t.shR -= Math.sin(time * 28) * 0.03 * u;
                    t.jaw = 0.5 + 0.2 * u;
                    break;
                }
                case 'beam': {
                    patchPose(t, f.def.moves.beam.strike);
                    t.hipL += 0.3;
                    t.hipR -= 0.25;
                    t.knL += 0.5;
                    t.knR += 0.2;
                    t.jaw = 0.65;
                    break;
                }
                case 'attack': {
                    const a = f.attack;
                    if (!a)
                        break;
                    copyPose(this.windup, b);
                    patchPose(this.windup, a.windup);
                    copyPose(this.strike, b);
                    patchPose(this.strike, a.strike);
                    const tm = f.attackTime;
                    if (tm < a.startup) {
                        lerpPose(t, b, this.windup, (0, math_js_8.easeOutCubic)(tm / Math.max(0.001, a.startup)));
                    }
                    else if (tm < a.startup + a.active) {
                        const u = (tm - a.startup) / (a.active * 0.5 + 0.02);
                        lerpPose(t, this.windup, this.strike, (0, math_js_8.easeOutCubic)(u));
                    }
                    else {
                        const u = (tm - a.startup - a.active) / Math.max(0.001, a.recovery);
                        lerpPose(t, this.strike, b, (0, math_js_8.easeInOut)(u));
                    }
                    if (a.air) {
                        t.hipL = Math.max(t.hipL, 0.6);
                        t.knL = Math.max(t.knL, 0.9);
                    }
                    // lunges lean into the target
                    if (a.lungeSpeed && tm < (a.lungeTime ?? a.startup + a.active))
                        t.rootPitch = 0.25;
                    break;
                }
                case 'transform': {
                    const u = (0, math_js_8.easeOutCubic)((0, math_js_8.clamp)(f.stateTime / 0.5, 0, 1));
                    t.shL = (0, math_js_8.lerp)(0.3, 2.7, u);
                    t.shR = (0, math_js_8.lerp)(0.3, 2.7, u);
                    t.shLr = 0.9 * u;
                    t.shRr = 0.9 * u;
                    t.elL = 0.3;
                    t.elR = 0.3;
                    t.torsoPitch = -0.18 * u;
                    t.headTilt = -0.35 * u;
                    t.hipL += 0.12 * (1 - u);
                    t.hipR += 0.12 * (1 - u);
                    t.rootY = Math.sin(time * 30) * 0.008 * H;
                    break;
                }
                case 'grabbing': {
                    const u = (0, math_js_8.clamp)(f.stateTime / 0.6, 0, 1);
                    t.shL = 1.4 + u * 1.2;
                    t.shR = 1.4 + u * 1.2;
                    t.elL = 0.6;
                    t.elR = 0.6;
                    t.torsoPitch = (0, math_js_8.lerp)(0.2, -0.3, u);
                    break;
                }
                case 'grabbed': {
                    t.rootPitch = -0.35;
                    t.rootY = 0.12 * H;
                    t.shL = -0.4;
                    t.shR = -0.4;
                    t.shLr = 0.7;
                    t.shRr = 0.7;
                    t.hipL = 0.3;
                    t.hipR = 0.1;
                    t.knL = 0.4;
                    t.knR = 0.4;
                    t.headTilt = -0.3;
                    break;
                }
                case 'victory': {
                    const pump = Math.sin(time * 4) * 0.12;
                    t.shL = 2.9 + pump;
                    t.shR = 2.7 - pump;
                    t.shLr = 0.35;
                    t.shRr = 0.35;
                    t.elL = 0.2;
                    t.elR = 0.3;
                    t.torsoPitch = -0.12;
                    t.headTilt = -0.25;
                    t.hipL = 0.05;
                    t.hipR = -0.05;
                    t.knL = 0.1;
                    t.knR = 0.1;
                    t.jaw = rig.style === 'kaiju' ? 0.7 : 0;
                    t.rootY = Math.abs(Math.sin(time * 4)) * 0.03 * H;
                    break;
                }
                default:
                    break;
            }
        }
    }
    exports.FighterAnimator = FighterAnimator;
    const scratch = (0, Renderer_js_1.newMaterial)();
    const stack = new math_js_8.MatStack(32);
    function setCol(m, c, k = 1) {
        m.color[0] = c[0] * k;
        m.color[1] = c[1] * k;
        m.color[2] = c[2] * k;
    }
    function sphere(ctx, c, x, y, z, sx, sy, sz, emissive = 0) {
        stack.push().translate(x, y, z).scale(sx, sy, sz);
        const m = (0, Renderer_js_1.resetMaterial)(ctx.m);
        setCol(m, c);
        m.flash = ctx.flash;
        m.rim = ctx.rim;
        m.spec = ctx.spec;
        m.alpha = ctx.alpha;
        if (emissive > 0) {
            m.emissive[0] = c[0] * emissive;
            m.emissive[1] = c[1] * emissive;
            m.emissive[2] = c[2] * emissive;
        }
        ctx.r.draw(ctx.r.meshes.sphere, stack.m, m);
        stack.pop();
    }
    function box(ctx, c, x, y, z, sx, sy, sz, emissive = 0) {
        stack.push().translate(x, y, z).scale(sx, sy, sz);
        const m = (0, Renderer_js_1.resetMaterial)(ctx.m);
        setCol(m, c);
        m.flash = ctx.flash;
        m.rim = ctx.rim;
        m.spec = ctx.spec;
        m.alpha = ctx.alpha;
        if (emissive > 0) {
            m.emissive[0] = c[0] * emissive;
            m.emissive[1] = c[1] * emissive;
            m.emissive[2] = c[2] * emissive;
        }
        ctx.r.draw(ctx.r.meshes.cube, stack.m, m);
        stack.pop();
    }
    /** Tapered cylinder hanging down from the current origin. */
    function limb(ctx, c, length, rTop, ratio) {
        stack.push().scale(rTop, length, rTop);
        const m = (0, Renderer_js_1.resetMaterial)(ctx.m);
        setCol(m, c);
        m.flash = ctx.flash;
        m.rim = ctx.rim;
        m.spec = ctx.spec;
        m.alpha = ctx.alpha;
        ctx.r.draw(ctx.r.limbMesh(ratio), stack.m, m);
        stack.pop();
    }
    function cone(ctx, c, x, y, z, rx, ry, rotX, rotZ, emissive = 0) {
        stack.push().translate(x, y, z).rotZ(rotZ).rotX(rotX).scale(rx, ry, rx);
        const m = (0, Renderer_js_1.resetMaterial)(ctx.m);
        setCol(m, c);
        m.flash = ctx.flash;
        m.rim = ctx.rim * 0.5;
        m.spec = ctx.spec * 0.5;
        m.alpha = ctx.alpha;
        if (emissive > 0) {
            m.emissive[0] = c[0] * emissive;
            m.emissive[1] = c[1] * emissive;
            m.emissive[2] = c[2] * emissive;
        }
        ctx.r.draw(ctx.r.meshes.cone, stack.m, m);
        stack.pop();
    }
    function reach(thigh, shin, hip, knee) {
        return thigh * Math.cos(hip) + shin * Math.cos(hip - knee);
    }
    function fighterWorldPos(f, alpha) {
        let dy = f.yaw - f.pyaw;
        if (dy > Math.PI)
            dy -= Math.PI * 2;
        else if (dy < -Math.PI)
            dy += Math.PI * 2;
        return {
            x: (0, math_js_8.lerp)(f.px, f.x, alpha), y: (0, math_js_8.lerp)(f.py, f.y, alpha), z: (0, math_js_8.lerp)(f.pz, f.z, alpha), yaw: f.pyaw + dy * alpha,
        };
    }
    function drawFighter(r, f, anim, alpha, time) {
        const p = anim.pose;
        const rig = f.def.rig;
        const col = rig.colors;
        const H = f.height;
        const bk = rig.bulk;
        const pos = fighterWorldPos(f, alpha);
        const dead = f.state === 'defeated';
        const ctx = {
            r, m: scratch, flash: f.flash * 0.75, rim: 0.7, spec: rig.style === 'kaiju' ? 0.25 : 0.7, alpha: 1,
        };
        const legLen = 0.46 * H;
        const thigh = 0.25 * H;
        const shin = 0.21 * H;
        const hipX = 0.06 * H * bk;
        const torsoH = 0.3 * H;
        const shoulderX = 0.125 * H * bk;
        const shoulderY = torsoH * 0.9;
        const upperArm = 0.15 * H;
        const fore = 0.14 * H;
        const headR = 0.075 * H * rig.headScale;
        const standing = Math.max(reach(thigh, shin, p.hipL, p.knL), reach(thigh, shin, p.hipR, p.knR));
        void legLen;
        // ---- blob shadow
        {
            const m = (0, Renderer_js_1.resetMaterial)(scratch);
            m.mode = 4;
            m.alpha = (0, math_js_8.clamp)(0.38 - pos.y * 0.015, 0.1, 0.38);
            m.color[0] = 0;
            m.color[1] = 0;
            m.color[2] = 0;
            stack.reset().translate(pos.x, 0.06, pos.z).scale(f.radius * 1.5, 1, f.radius * 1.5);
            r.draw(r.meshes.disc, stack.m, m);
        }
        stack.reset();
        stack.translate(pos.x, pos.y + p.rootY, pos.z).rotY(pos.yaw).translate(0, 0, p.rootZ).rotX(p.rootPitch).rotZ(p.rootRoll);
        stack.translate(0, standing, 0);
        // ---- pelvis
        sphere(ctx, col.body, 0, 0, 0, hipX * 1.9, 0.05 * H, 0.07 * H * bk);
        if (rig.style !== 'kaiju')
            box(ctx, col.accent, 0, -0.012 * H, 0, hipX * 3.5, 0.016 * H, 0.1 * H * bk * 0.72);
        // ---- tail (kaiju)
        if (rig.extras.includes('tail')) {
            stack.push().translate(0, 0.0, -0.05 * H * bk).rotX(Math.PI / 2 - 0.45 + p.tail * 0.15).rotY(p.tail * 0.5);
            let w = 0.055 * H * bk;
            for (let i = 0; i < 6; i++) {
                limb(ctx, i % 2 === 0 ? col.body : col.limb, 0.11 * H, w, 0.78);
                stack.translate(0, -0.11 * H, 0).rotX(-0.1).rotY(p.tail * 0.35);
                w *= 0.78;
            }
            stack.pop();
        }
        // ---- legs
        for (const side of [1, -1]) {
            const hip = side === 1 ? p.hipL : p.hipR;
            const kn = side === 1 ? p.knL : p.knR;
            stack.push().translate(side * hipX, -0.01 * H, 0).rotX(-hip);
            limb(ctx, col.limb, thigh, 0.056 * H * bk, 0.7);
            stack.translate(0, -thigh, 0);
            sphere(ctx, col.body, 0, 0, 0, 0.042 * H * bk, 0.042 * H * bk, 0.042 * H * bk);
            stack.rotX(kn);
            limb(ctx, col.limb, shin, 0.045 * H * bk, 0.72);
            if (rig.style === 'speed')
                box(ctx, col.accent, 0, -shin * 0.45, 0.04 * H, 0.012 * H, shin * 0.5, 0.03 * H);
            stack.translate(0, -shin, 0);
            box(ctx, rig.style === 'kaiju' ? col.body : col.accent, 0, 0.01 * H, 0.035 * H, 0.062 * H * bk, 0.03 * H, 0.1 * H * bk);
            if (rig.style === 'kaiju') {
                for (const cx of [-1, 0, 1])
                    cone(ctx, [0.9, 0.85, 0.7], cx * 0.02 * H * bk, 0.012 * H, 0.1 * H * bk, 0.012 * H, 0.04 * H, Math.PI / 2, 0);
            }
            stack.pop();
        }
        // ---- torso group
        stack.push().translate(0, 0.012 * H, 0).rotX(p.torsoPitch).rotY(p.torsoYaw);
        // waist -> shoulders taper
        stack.push().translate(0, torsoH * 0.88, 0);
        limb(ctx, col.body, torsoH * 0.88, 0.1 * H * bk, 0.66);
        stack.pop();
        sphere(ctx, col.body, 0, torsoH * 0.74, 0, 0.128 * H * bk, 0.092 * H, 0.088 * H * bk);
        if (rig.style === 'kaiju') {
            // belly plates
            for (let i = 0; i < 4; i++) {
                sphere(ctx, col.limb, 0, torsoH * (0.2 + i * 0.15), 0.07 * H * bk, 0.075 * H * bk, 0.028 * H, 0.03 * H);
            }
        }
        else {
            // chest plate in accent colour
            sphere(ctx, col.accent, 0, torsoH * 0.72, 0.062 * H * bk, 0.082 * H * bk, 0.08 * H, 0.032 * H);
            if (rig.style === 'hero') {
                box(ctx, col.accent, 0, torsoH * 0.9, 0.04 * H, 0.2 * H * bk, 0.02 * H, 0.1 * H * bk);
            }
        }
        if (rig.extras.includes('timer')) {
            // Colour timer: blue while healthy, blinking red once the timer has run out.
            const warn = f.timerExpired || (f.def.timer ? f.timerLeft / f.def.timer.seconds < 0.2 : false);
            const blink = warn ? (Math.sin(time * 12) > 0 ? 1 : 0.15) : 1;
            const c = warn ? [1, 0.12, 0.08] : [0.3, 0.8, 1];
            sphere(ctx, [c[0] * blink, c[1] * blink, c[2] * blink], 0, torsoH * 0.7, 0.092 * H * bk, 0.022 * H, 0.022 * H, 0.016 * H, 1.6);
        }
        if (rig.extras.includes('spikes')) {
            for (let i = 0; i < 5; i++) {
                const y = torsoH * (0.25 + i * 0.16);
                cone(ctx, col.accent, 0, y, -0.088 * H * bk, 0.03 * H * bk, (0.09 - i * 0.008) * H, -0.9, 0, 0.35);
            }
        }
        if (rig.extras.includes('fins')) {
            box(ctx, col.accent, 0, torsoH * 0.7, -0.09 * H * bk, 0.012 * H, 0.16 * H, 0.05 * H);
        }
        // ---- arms
        for (const side of [1, -1]) {
            const sh = side === 1 ? p.shL : p.shR;
            const sr = side === 1 ? p.shLr : p.shRr;
            const el = side === 1 ? p.elL : p.elR;
            stack.push().translate(side * shoulderX, shoulderY, 0).rotZ(side * sr).rotX(-sh);
            sphere(ctx, rig.style === 'kaiju' ? col.body : col.accent, 0, 0, 0, 0.056 * H * bk, 0.056 * H * bk, 0.056 * H * bk);
            if (rig.extras.includes('shoulders') || rig.style === 'kaiju') {
                cone(ctx, col.accent, side * 0.03 * H, 0.03 * H, 0, 0.018 * H, 0.06 * H, 0, -side * 0.7, 0.3);
            }
            limb(ctx, col.limb, upperArm, 0.041 * H * bk, 0.74);
            stack.translate(0, -upperArm, 0);
            sphere(ctx, col.body, 0, 0, 0, 0.034 * H * bk, 0.034 * H * bk, 0.034 * H * bk);
            stack.rotX(-el);
            limb(ctx, col.limb, fore, 0.034 * H * bk, 0.82);
            if (rig.style === 'speed') {
                box(ctx, col.accent, side * 0.02 * H, -fore * 0.5, -0.01 * H, 0.008 * H, fore * 0.6, 0.05 * H);
            }
            stack.translate(0, -fore, 0);
            sphere(ctx, rig.style === 'kaiju' ? col.body : col.accent, 0, -0.01 * H, 0, 0.044 * H * bk, 0.044 * H * bk, 0.044 * H * bk);
            if (side === -1 && rig.extras.includes('sword')) {
                // Blade along the hand's local +Z: it points forward when the arm hangs, up when the arm is raised
                // forward and back over the head in a wind-up, so every slice swings it naturally.
                const blade = [0.9, 0.94, 1];
                box(ctx, col.accent, 0, -0.01 * H, 0.03 * H, 0.05 * H, 0.014 * H, 0.012 * H); // cross guard
                box(ctx, blade, 0, -0.01 * H, 0.33 * H, 0.011 * H, 0.03 * H, 0.29 * H, 0.12);
                box(ctx, col.glow, 0, -0.01 * H + 0.03 * H, 0.33 * H, 0.009 * H, 0.004 * H, 0.29 * H, 1.6); // glowing edges
                box(ctx, col.glow, 0, -0.01 * H - 0.03 * H, 0.33 * H, 0.009 * H, 0.004 * H, 0.29 * H, 1.6);
                cone(ctx, blade, 0, -0.01 * H, 0.64 * H, 0.03 * H, 0.05 * H, Math.PI / 2, 0, 0.12);
            }
            if (rig.style === 'kaiju') {
                for (const cx of [-1, 0, 1]) {
                    cone(ctx, [0.95, 0.9, 0.75], cx * 0.022 * H * bk, -0.03 * H, 0.02 * H, 0.011 * H, 0.06 * H, Math.PI, 0);
                }
            }
            stack.pop();
        }
        // ---- head
        stack.push().translate(0, torsoH + 0.035 * H + headR * 0.7, 0).rotX(p.headTilt).rotY(p.headYaw);
        sphere(ctx, rig.style === 'kaiju' ? col.body : col.body, 0, 0, 0, headR, headR * 1.12, headR * 1.08);
        if (rig.style === 'kaiju') {
            // snout + jaw that opens while charging
            sphere(ctx, col.body, 0, -headR * 0.15, headR * 0.7, headR * 0.7, headR * 0.5, headR * 0.7);
            stack.push().translate(0, -headR * 0.5, headR * 0.35).rotX(p.jaw);
            sphere(ctx, col.limb, 0, -headR * 0.08, headR * 0.4, headR * 0.62, headR * 0.28, headR * 0.72);
            for (let i = -2; i <= 2; i++)
                cone(ctx, [0.95, 0.92, 0.8], i * headR * 0.22, headR * 0.1, headR * 0.7, headR * 0.06, headR * 0.2, 0, 0);
            stack.pop();
            if (p.jaw > 0.4) {
                sphere(ctx, col.glow, 0, -headR * 0.45, headR * 0.9, headR * 0.28, headR * 0.2, headR * 0.28, 2.2);
            }
        }
        const eyeOn = dead ? 0.15 : 1;
        sphere(ctx, [col.eye[0] * eyeOn, col.eye[1] * eyeOn, col.eye[2] * eyeOn], headR * 0.44, headR * 0.12, headR * 0.84, headR * 0.3, headR * 0.15, headR * 0.12, 1.8);
        sphere(ctx, [col.eye[0] * eyeOn, col.eye[1] * eyeOn, col.eye[2] * eyeOn], -headR * 0.44, headR * 0.12, headR * 0.84, headR * 0.3, headR * 0.15, headR * 0.12, 1.8);
        if (rig.extras.includes('crest')) {
            box(ctx, col.accent, 0, headR * 1.05, -headR * 0.1, headR * 0.16, headR * 0.7, headR * 1.5);
        }
        if (rig.extras.includes('fins')) {
            box(ctx, col.accent, 0, headR * 1.0, -headR * 0.3, headR * 0.14, headR * 1.0, headR * 1.3);
            box(ctx, col.accent, headR * 1.0, headR * 0.1, -headR * 0.1, headR * 0.1, headR * 0.5, headR * 0.7);
            box(ctx, col.accent, -headR * 1.0, headR * 0.1, -headR * 0.1, headR * 0.1, headR * 0.5, headR * 0.7);
        }
        if (rig.extras.includes('horns')) {
            cone(ctx, [0.92, 0.88, 0.75], headR * 0.55, headR * 0.85, -headR * 0.1, headR * 0.2, headR * 1.1, -0.5, -0.5);
            cone(ctx, [0.92, 0.88, 0.75], -headR * 0.55, headR * 0.85, -headR * 0.1, headR * 0.2, headR * 1.1, -0.5, 0.5);
        }
        stack.pop();
        stack.pop(); // torso group
    }
});
define("render/StageRenderer", ["require", "exports", "data/stages", "math", "render/Renderer"], function (require, exports, stages_js_2, math_js_9, Renderer_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.StageRenderer = void 0;
    const DENSITY = { low: 0.5, medium: 0.8, high: 1 };
    /** Draws the arena: ground, boundary ring, scenery and destructible props (with staged damage). */
    class StageRenderer {
        r;
        stage = null;
        backdrop = [];
        stack = new math_js_9.MatStack(8);
        mat = (0, Renderer_js_2.newMaterial)();
        constructor(r) {
            this.r = r;
        }
        setStage(stage, quality) {
            this.stage = stage;
            this.backdrop = (0, stages_js_2.buildBackdrop)(stage, DENSITY[quality]);
        }
        environment() {
            const s = this.stage;
            if (!s)
                throw new Error('StageRenderer: no stage set');
            return {
                skyTop: s.skyTop, skyHorizon: s.skyHorizon, fog: s.fog, fogDensity: s.fogDensity,
                sunDir: s.sunDir, sunColor: s.sunColor, skyAmbient: s.skyAmbient, groundAmbient: s.groundAmbient,
                stars: s.stars, ground: s.ground, groundLine: s.groundLine, ringGlow: s.ringGlow,
                arenaRadius: s.radius, theme: s.theme === 'volcano' ? 1 : 0,
            };
        }
        /**
         * 0.16..1 opacity for scenery near the camera or between the camera and the point of interest, so nothing can
         * hide the fighters. `size` is the object's horizontal half-extent.
         */
        occlusion(x, z, size, eye, target) {
            const sx = target[0] - eye[0];
            const sz = target[2] - eye[2];
            const len2 = sx * sx + sz * sz || 1;
            let t = ((x - eye[0]) * sx + (z - eye[2]) * sz) / len2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const lateral = Math.hypot(x - (eye[0] + sx * t), z - (eye[2] + sz * t));
            const near = Math.hypot(x - eye[0], z - eye[2]);
            const byLine = (0, math_js_9.smoothstep)(size * 0.8, size + 9, lateral);
            const byEye = (0, math_js_9.smoothstep)(10, 34, near);
            return (0, math_js_9.lerp)(0.16, 1, Math.min(byLine, byEye));
        }
        draw(battle, time, eye = [0, 20, -60], target = [0, 5, 0]) {
            const s = this.stage;
            if (!s)
                return;
            const r = this.r;
            const st = this.stack;
            const night = s.theme === 'night-city';
            const volcano = s.theme === 'volcano';
            // ---- ground
            {
                const m = (0, Renderer_js_2.resetMaterial)(this.mat);
                m.mode = 1;
                m.color[0] = s.ground[0];
                m.color[1] = s.ground[1];
                m.color[2] = s.ground[2];
                m.color2[0] = s.groundLine[0];
                m.color2[1] = s.groundLine[1];
                m.color2[2] = s.groundLine[2];
                m.emissive[0] = s.ringGlow[0];
                m.emissive[1] = s.ringGlow[1];
                m.emissive[2] = s.ringGlow[2];
                st.reset().scale(420, 1, 420);
                r.draw(r.meshes.disc, st.m, m);
            }
            // ---- distant volcano peak
            if (volcano) {
                const m = (0, Renderer_js_2.resetMaterial)(this.mat);
                m.color[0] = 0.12;
                m.color[1] = 0.08;
                m.color[2] = 0.07;
                m.rim = 0.6;
                m.rimColor[0] = 1;
                m.rimColor[1] = 0.35;
                m.rimColor[2] = 0.1;
                st.reset().translate(-70, 0, -190).scale(110, 120, 110);
                r.draw(r.meshes.cone, st.m, m);
                const g = (0, Renderer_js_2.resetMaterial)(this.mat);
                g.mode = 3;
                g.additive = true;
                g.alpha = 0.55 + 0.15 * Math.sin(time * 2);
                g.color[0] = 1;
                g.color[1] = 0.4;
                g.color[2] = 0.08;
                st.reset().translate(-70, 118, -190).scale(26, 9, 26);
                r.draw(r.meshes.sphere, st.m, g);
            }
            if (night) {
                const m = (0, Renderer_js_2.resetMaterial)(this.mat);
                m.mode = 4;
                m.color[0] = 0.95;
                m.color[1] = 0.97;
                m.color[2] = 1;
                st.reset().translate(120, 150, -260).scale(14, 14, 14);
                r.draw(r.meshes.sphere, st.m, m);
            }
            // ---- scenery
            for (const b of this.backdrop) {
                const m = (0, Renderer_js_2.resetMaterial)(this.mat);
                m.alpha = this.occlusion(b.x, b.z, Math.max(b.w, b.d) * 0.5, eye, target);
                const k = b.shade;
                m.color[0] = s.propColor[0] * k;
                m.color[1] = s.propColor[1] * k;
                m.color[2] = s.propColor[2] * k;
                if (volcano) {
                    m.rim = 0.4;
                    m.rimColor[0] = 1;
                    m.rimColor[1] = 0.35;
                    m.rimColor[2] = 0.1;
                    st.reset().translate(b.x, 0, b.z).rotY(b.rot).scale(b.w, b.h, b.w);
                    r.draw(r.meshes.cone, st.m, m);
                }
                else {
                    m.mode = 2;
                    m.color2[0] = s.windowColor[0];
                    m.color2[1] = s.windowColor[1];
                    m.color2[2] = s.windowColor[2];
                    const glow = night ? 1.2 : 0.18;
                    m.emissive[0] = s.windowColor[0] * glow;
                    m.emissive[1] = s.windowColor[1] * glow;
                    m.emissive[2] = s.windowColor[2] * glow;
                    m.rim = 0.3;
                    st.reset().translate(b.x, b.h / 2, b.z).rotY(b.rot).scale(b.w, b.h, b.d);
                    r.draw(r.meshes.cube, st.m, m);
                }
            }
            // ---- destructible props (staged damage: intact -> cracked/shorter -> rubble)
            if (battle) {
                for (const p of battle.props) {
                    const m = (0, Renderer_js_2.resetMaterial)(this.mat);
                    if (!p.alive) {
                        m.color[0] = p.color[0] * 0.45;
                        m.color[1] = p.color[1] * 0.45;
                        m.color[2] = p.color[2] * 0.45;
                        st.reset().translate(p.x, 0.35, p.z).rotY(p.rot).scale(p.w * 0.9, 0.7, p.d * 0.9);
                        r.draw(r.meshes.cube, st.m, m);
                        continue;
                    }
                    m.alpha = this.occlusion(p.x, p.z, Math.max(p.w, p.d) * 0.5, eye, target);
                    const dmg = 1 - p.hp / p.maxHp;
                    const k = 1 - dmg * 0.4;
                    m.color[0] = p.color[0] * k;
                    m.color[1] = p.color[1] * k;
                    m.color[2] = p.color[2] * k;
                    const h = p.h * (0, math_js_9.lerp)(1, 0.55, dmg);
                    const tilt = dmg > 0.66 ? 0.12 : 0;
                    if (p.kind === 'rock') {
                        m.rim = 0.4;
                        m.rimColor[0] = 1;
                        m.rimColor[1] = 0.4;
                        m.rimColor[2] = 0.1;
                        st.reset().translate(p.x, 0, p.z).rotY(p.rot).rotZ(tilt).scale(p.w, h, p.w);
                        r.draw(r.meshes.cone, st.m, m);
                    }
                    else {
                        m.mode = 2;
                        m.color2[0] = s.windowColor[0];
                        m.color2[1] = s.windowColor[1];
                        m.color2[2] = s.windowColor[2];
                        const glow = night ? 1.1 : 0.15;
                        m.emissive[0] = s.windowColor[0] * glow * (1 - dmg);
                        m.emissive[1] = s.windowColor[1] * glow * (1 - dmg);
                        m.emissive[2] = s.windowColor[2] * glow * (1 - dmg);
                        m.rim = 0.3;
                        st.reset().translate(p.x, 0, p.z).rotY(p.rot).rotZ(tilt).translate(0, h / 2, 0).scale(p.w, h, p.d);
                        r.draw(r.meshes.cube, st.m, m);
                    }
                }
            }
        }
    }
    exports.StageRenderer = StageRenderer;
});
define("render/VFX", ["require", "exports", "math", "render/Renderer"], function (require, exports, math_js_10, Renderer_js_3) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.VFX = void 0;
    const CAPACITY = { low: 160, medium: 320, high: 640 };
    const POOL = 640;
    /**
     * Pooled particle / shockwave / flash effects plus beam and projectile rendering. All pools are fixed-size, so
     * effects can never grow without bound and nothing is allocated per frame.
     */
    class VFX {
        parts = [];
        rings = Array.from({ length: 32 }, () => ({
            on: false, x: 0, y: 0, z: 0, r0: 0, r1: 0, life: 0, max: 1, r: 1, g: 1, b: 1, flat: true, yaw: 0,
        }));
        flashes = Array.from({ length: 16 }, () => ({
            on: false, x: 0, y: 0, z: 0, size: 1, life: 0, max: 1, r: 1, g: 1, b: 1,
        }));
        /** Scratch colour (no per-frame allocation). */
        tint = [1, 1, 1];
        clock = 0;
        lastBreakAt = -1;
        breakBurst = 0;
        cursor = 0;
        ringCursor = 0;
        flashCursor = 0;
        quality = 'high';
        rng = new math_js_10.Rng(7);
        stack = new math_js_10.MatStack(8);
        mat = (0, Renderer_js_3.newMaterial)();
        /** Sum of beam power currently on screen (drives the audio hum). */
        beamPower = 0;
        /** Particles drawn last frame (diagnostics). */
        activeCount = 0;
        constructor() {
            for (let i = 0; i < POOL; i++) {
                this.parts.push({
                    on: false, kind: 0 /* Kind.Spark */, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, size: 1, grow: 0,
                    r: 1, g: 1, b: 1, grav: 0, drag: 0, rot: 0, spin: 0,
                });
            }
        }
        setQuality(q) {
            this.quality = q;
        }
        clear() {
            for (const p of this.parts)
                p.on = false;
            for (const r of this.rings)
                r.on = false;
            for (const f of this.flashes)
                f.on = false;
        }
        get cap() {
            return CAPACITY[this.quality];
        }
        count(n) {
            return Math.max(1, Math.round(n * (this.quality === 'high' ? 1 : this.quality === 'medium' ? 0.6 : 0.35)));
        }
        alloc() {
            const cap = this.cap;
            for (let i = 0; i < cap; i++) {
                this.cursor = (this.cursor + 1) % cap;
                const p = this.parts[this.cursor];
                if (!p.on)
                    return p;
            }
            return null;
        }
        spawn(kind, x, y, z, vx, vy, vz, life, size, c, grav = 0, drag = 0, grow = 0) {
            const p = this.alloc();
            if (!p)
                return;
            p.on = true;
            p.kind = kind;
            p.x = x;
            p.y = y;
            p.z = z;
            p.vx = vx;
            p.vy = vy;
            p.vz = vz;
            p.life = life;
            p.max = life;
            p.size = size;
            p.grow = grow;
            p.r = c[0];
            p.g = c[1];
            p.b = c[2];
            p.grav = grav;
            p.drag = drag;
            p.rot = this.rng.range(0, 6.28);
            p.spin = this.rng.range(-6, 6);
        }
        ring(x, y, z, r0, r1, life, c, flat = true, yaw = 0) {
            const r = this.rings[this.ringCursor];
            this.ringCursor = (this.ringCursor + 1) % this.rings.length;
            r.on = true;
            r.x = x;
            r.y = y;
            r.z = z;
            r.r0 = r0;
            r.r1 = r1;
            r.life = life;
            r.max = life;
            r.r = c[0];
            r.g = c[1];
            r.b = c[2];
            r.flat = flat;
            r.yaw = yaw;
        }
        flash(x, y, z, size, life, c) {
            const f = this.flashes[this.flashCursor];
            this.flashCursor = (this.flashCursor + 1) % this.flashes.length;
            f.on = true;
            f.x = x;
            f.y = y;
            f.z = z;
            f.size = size;
            f.life = life;
            f.max = life;
            f.r = c[0];
            f.g = c[1];
            f.b = c[2];
        }
        sparks(x, y, z, n, speed, c, life = 0.45, size = 0.35) {
            const rng = this.rng;
            for (let i = 0; i < this.count(n); i++) {
                const a = rng.range(0, Math.PI * 2);
                const e = rng.range(-0.4, 1);
                const s = speed * rng.range(0.35, 1);
                this.spawn(0 /* Kind.Spark */, x, y, z, Math.cos(a) * s, e * s, Math.sin(a) * s, life * rng.range(0.6, 1.2), size * rng.range(0.6, 1.2), c, 14, 1.2);
            }
        }
        dust(x, y, z, n, speed, c, size = 2) {
            const rng = this.rng;
            for (let i = 0; i < this.count(n); i++) {
                const a = rng.range(0, Math.PI * 2);
                const s = speed * rng.range(0.4, 1);
                this.spawn(1 /* Kind.Dust */, x + Math.cos(a) * 1.2, y, z + Math.sin(a) * 1.2, Math.cos(a) * s, rng.range(0.5, 3.5), Math.sin(a) * s, rng.range(0.7, 1.4), size * rng.range(0.6, 1.3), c, -0.5, 1.6, 2.2);
            }
        }
        debris(x, y, z, n, speed, c, size = 0.9) {
            const rng = this.rng;
            for (let i = 0; i < this.count(n); i++) {
                const a = rng.range(0, Math.PI * 2);
                const s = speed * rng.range(0.3, 1);
                const k = rng.range(0.7, 1.1);
                this.spawn(2 /* Kind.Debris */, x, y, z, Math.cos(a) * s, rng.range(4, speed), Math.sin(a) * s, rng.range(0.9, 1.7), Math.min(0.75, size) * rng.range(0.35, 1.2), [c[0] * k, c[1] * k, c[2] * k], 22, 0.05);
            }
        }
        // ------------------------------------------------------------------- events
        handle(e, battle) {
            const WHITE = [1, 1, 1];
            const GOLD = [1, 0.85, 0.35];
            const BLUE = [0.45, 0.75, 1];
            const RED = [1, 0.3, 0.2];
            const DUST = [0.62, 0.58, 0.52];
            switch (e.type) {
                case 'hit': {
                    const s = e.strength;
                    const c = e.heavy ? [1, 0.7, 0.3] : WHITE;
                    this.sparks(e.x, e.y, e.z, 8 + s * 10, 16 + s * 8, c);
                    this.flash(e.x, e.y, e.z, 2 + s * 2.5, 0.16, c);
                    this.ring(e.x, e.y, e.z, 0.5, 3 + s * 3, 0.25, c, false, battle.fighters[e.attacker].yaw);
                    if (e.heavy)
                        this.dust(e.x, 0.3, e.z, 5, 8, DUST, 2.5);
                    break;
                }
                case 'block':
                    this.sparks(e.x, e.y, e.z, 7, 12, BLUE, 0.3, 0.28);
                    this.ring(e.x, e.y, e.z, 0.4, 3.2, 0.2, BLUE, false, battle.fighters[e.attacker].yaw);
                    break;
                case 'counter':
                    this.sparks(e.x, e.y, e.z, 20, 24, GOLD, 0.6);
                    this.flash(e.x, e.y, e.z, 6, 0.25, GOLD);
                    this.ring(e.x, e.y, e.z, 0.5, 8, 0.4, GOLD, false, battle.fighters[e.attacker].yaw);
                    break;
                case 'guardbreak':
                    this.sparks(e.x, e.y, e.z, 24, 26, RED, 0.7);
                    this.flash(e.x, e.y, e.z, 6, 0.3, RED);
                    this.ring(e.x, e.y, e.z, 0.5, 9, 0.45, RED, false);
                    break;
                case 'armor':
                    this.sparks(e.x, e.y, e.z, 6, 10, [0.8, 0.8, 0.85], 0.3);
                    break;
                case 'evade':
                    this.ring(e.x, e.y, e.z, 1, 5, 0.3, [0.6, 0.9, 1], false);
                    break;
                case 'land': {
                    const k = (0, math_js_10.saturate)(e.strength);
                    this.dust(e.x, 0.3, e.z, 6 + k * 10, 7 + k * 8, DUST, 2.4);
                    this.ring(e.x, 0.2, e.z, 1, 6 + k * 10, 0.5, [0.8, 0.75, 0.65], true);
                    break;
                }
                case 'stomp':
                    this.ring(e.x, 0.2, e.z, 1, e.radius, 0.55, [1, 0.85, 0.6], true);
                    this.ring(e.x, 0.3, e.z, 1, e.radius * 0.7, 0.4, WHITE, true);
                    this.dust(e.x, 0.3, e.z, 18, 16, DUST, 3.4);
                    this.debris(e.x, 0.5, e.z, 8, 14, [0.5, 0.45, 0.4]);
                    break;
                case 'throw':
                    this.dust(e.x, 0.3, e.z, 16, 16, DUST, 3);
                    this.ring(e.x, 0.2, e.z, 1, 14, 0.5, [0.9, 0.8, 0.6], true);
                    this.sparks(e.x, e.y, e.z, 14, 20, WHITE);
                    break;
                case 'techbreak':
                    this.ring(e.x, e.y, e.z, 1, 9, 0.35, [0.5, 1, 0.8], false);
                    this.sparks(e.x, e.y, e.z, 12, 18, [0.5, 1, 0.8]);
                    break;
                case 'dodge':
                    this.dust(e.x, 0.3, e.z, 5, 7, DUST, 2);
                    break;
                case 'jump':
                    this.dust(e.x, 0.3, e.z, 8, 9, DUST, 2.4);
                    break;
                case 'projectileHit':
                    this.sparks(e.x, e.y, e.z, 18, 22, e.color, 0.5);
                    this.flash(e.x, e.y, e.z, 5, 0.25, e.color);
                    this.ring(e.x, e.y, e.z, 0.5, 6, 0.3, e.color, false);
                    break;
                case 'beamFire': {
                    const f = battle.fighters[e.fighter];
                    const c = f.def.moves.beam.color;
                    this.flash(f.x + f.forwardX * f.radius, f.y + f.height * 0.62, f.z + f.forwardZ * f.radius, 6 + e.power * 2, 0.3, c);
                    break;
                }
                case 'clashStart':
                    this.flash(e.x, e.y, e.z, 8, 0.3, WHITE);
                    this.ring(e.x, e.y, e.z, 1, 12, 0.4, WHITE, false);
                    break;
                case 'clashEnd':
                    this.flash(e.x, e.y, e.z, 16, 0.5, WHITE);
                    this.ring(e.x, e.y, e.z, 1, 30, 0.7, WHITE, false);
                    this.ring(e.x, 0.3, e.z, 1, 26, 0.7, [1, 0.8, 0.5], true);
                    this.sparks(e.x, e.y, e.z, 40, 34, WHITE, 0.8, 0.5);
                    break;
                case 'propBroken': {
                    const s = e.w;
                    // A shockwave can level several buildings in one tick. The first two get the full effect; the rest get a
                    // light version so the burst stays dramatic without burying the fighters.
                    if (this.clock - this.lastBreakAt > 0.4)
                        this.breakBurst = 0;
                    this.lastBreakAt = this.clock;
                    const full = ++this.breakBurst <= 2;
                    this.debris(e.x, e.y, e.z, full ? 22 : 6, 14 + s, e.color, full ? 1 : 0.7);
                    this.dust(e.x, 1, e.z, full ? 20 : 5, 10, [0.55, 0.52, 0.5], 4 + s * 0.3);
                    if (full) {
                        this.ring(e.x, 0.2, e.z, 1, 10 + s, 0.55, [0.75, 0.7, 0.6], true);
                        this.flash(e.x, e.y * 0.5, e.z, 6, 0.25, [1, 0.7, 0.35]);
                    }
                    break;
                }
                case 'propHit':
                    this.dust(e.x, e.y, e.z, 4, 6, [0.55, 0.52, 0.5], 2);
                    this.debris(e.x, e.y, e.z, 4, 8, [0.5, 0.48, 0.46], 0.7);
                    break;
                case 'transformStart':
                    this.ring(e.x, 0.3, e.z, 1, 12, 0.6, e.color, true);
                    this.sparks(e.x, e.y, e.z, 16, 14, e.color, 0.6, 0.3);
                    break;
                case 'transform': {
                    // Burst size follows the form's configured intensity (reverting uses a modest default).
                    const k = battle.fighters[e.fighter].form?.burst ?? 0.6;
                    this.flash(e.x, e.y, e.z, 6 + 5 * k, 0.3 + 0.1 * k, e.color);
                    this.ring(e.x, e.y, e.z, 1, 8 + 6 * k, 0.45, WHITE, false);
                    this.ring(e.x, 0.3, e.z, 1, 14 + 8 * k, 0.7, e.color, true);
                    this.ring(e.x, 0.4, e.z, 1, 8 + 5 * k, 0.5, WHITE, true);
                    this.sparks(e.x, e.y, e.z, 20 + 14 * k, 20 + 10 * k, e.color, 0.7, 0.3);
                    break;
                }
                case 'transformCancel': {
                    const f = battle.fighters[e.fighter];
                    this.sparks(f.x, f.y + f.height * 0.5, f.z, 14, 16, [0.7, 0.7, 0.75], 0.4, 0.3);
                    break;
                }
                case 'ultimateReady': {
                    const f = battle.fighters[e.fighter];
                    const c = f.def.moves.ultimate.color;
                    this.ring(f.x, 0.3, f.z, f.radius, f.radius * 4, 0.7, c, true);
                    this.sparks(f.x, f.y + f.height * 0.5, f.z, 10, 12, c, 0.5, 0.25);
                    break;
                }
                case 'ultimateStart': {
                    const f = battle.fighters[e.fighter];
                    const c = f.def.moves.ultimate.color;
                    this.ring(f.x, 0.3, f.z, 1, f.radius * 5, 0.5, c, true);
                    this.flash(f.x, f.y + f.height * 0.55, f.z, f.height * 0.8, 0.25, c);
                    break;
                }
                case 'ultimateFire': {
                    const f = battle.fighters[e.fighter];
                    const u = f.def.moves.ultimate;
                    const hx = f.x + f.forwardX * f.radius * 1.2;
                    const hz = f.z + f.forwardZ * f.radius * 1.2;
                    const hy = f.y + f.height * 0.6;
                    if (u.kind === 'beam') {
                        this.flash(hx, hy, hz, 12, 0.35, u.coreColor);
                        this.ring(hx, hy, hz, 1, 14, 0.45, u.color, false, f.yaw);
                        this.ring(hx, hy, hz, 1, 9, 0.35, WHITE, false, f.yaw);
                        this.sparks(hx, hy, hz, 30, 30, u.color, 0.6, 0.35);
                    }
                    else if (u.kind === 'shockwave') {
                        const rad = u.attack.radius ?? 20;
                        this.ring(f.x, 0.25, f.z, 1, rad, 0.7, u.color, true);
                        this.ring(f.x, 0.3, f.z, 1, rad * 0.7, 0.5, u.coreColor, true);
                        this.ring(f.x, 0.35, f.z, 1, rad * 0.4, 0.35, WHITE, true);
                        this.debris(f.x, 1, f.z, 16, 30, [0.55, 0.42, 0.3], 0.9);
                        this.dust(f.x, 0.5, f.z, 16, 18, [0.62, 0.55, 0.48], 4);
                        this.flash(f.x, 2, f.z, 16, 0.4, u.color);
                    }
                    else if (u.kind === 'finisher') {
                        this.ring(f.x, 0.3, f.z, 1, 12, 0.35, u.color, true);
                        this.sparks(f.x, f.y + f.height * 0.5, f.z, 28, 36, u.color, 0.5, 0.3);
                        this.flash(f.x, f.y + f.height * 0.5, f.z, 9, 0.2, WHITE);
                    }
                    else {
                        this.flash(hx, hy, hz, 14, 0.4, u.coreColor);
                        this.ring(hx, hy, hz, 1, 16, 0.5, u.color, false, f.yaw);
                        this.ring(f.x, 0.3, f.z, 1, 14, 0.5, u.color, true);
                        this.sparks(hx, hy, hz, 34, 34, u.color, 0.7, 0.4);
                    }
                    break;
                }
                case 'ultimateEnd':
                    if (e.interrupted) {
                        const f = battle.fighters[e.fighter];
                        this.sparks(f.x, f.y + f.height * 0.55, f.z, 22, 22, [0.75, 0.75, 0.8], 0.5, 0.3);
                        this.ring(f.x, f.y + f.height * 0.55, f.z, 1, 7, 0.3, [0.7, 0.7, 0.75], false);
                    }
                    break;
                case 'perfectDodge':
                    this.ring(e.x, e.y, e.z, 1, 9, 0.35, [0.5, 0.9, 1], false);
                    this.sparks(e.x, e.y, e.z, 14, 22, [0.6, 0.95, 1], 0.4, 0.25);
                    this.flash(e.x, e.y, e.z, 6, 0.2, [0.6, 0.95, 1]);
                    break;
                case 'ko':
                    this.flash(e.x, e.y, e.z, 20, 0.7, WHITE);
                    this.ring(e.x, e.y, e.z, 1, 36, 0.9, WHITE, false);
                    this.ring(e.x, 0.3, e.z, 1, 32, 1, [1, 0.7, 0.4], true);
                    this.sparks(e.x, e.y, e.z, 50, 36, GOLD, 1, 0.5);
                    this.debris(e.x, e.y, e.z, 14, 24, [0.7, 0.55, 0.4]);
                    break;
                default:
                    break;
            }
        }
        // ------------------------------------------------------------------- update
        update(dt, battle) {
            this.clock += dt;
            for (const p of this.parts) {
                if (!p.on)
                    continue;
                p.life -= dt;
                if (p.life <= 0) {
                    p.on = false;
                    continue;
                }
                const d = Math.exp(-p.drag * dt);
                p.vx *= d;
                p.vz *= d;
                p.vy = (p.vy - p.grav * dt) * (p.kind === 1 /* Kind.Dust */ ? d : 1);
                p.x += p.vx * dt;
                p.y += p.vy * dt;
                p.z += p.vz * dt;
                if (p.y < 0.1 && p.kind !== 1 /* Kind.Dust */) {
                    p.y = 0.1;
                    p.vy *= -0.3;
                    p.vx *= 0.6;
                    p.vz *= 0.6;
                }
                p.size += p.grow * dt;
                p.rot += p.spin * dt;
            }
            for (const r of this.rings)
                if (r.on && (r.life -= dt) <= 0)
                    r.on = false;
            for (const f of this.flashes)
                if (f.on && (f.life -= dt) <= 0)
                    f.on = false;
            this.beamPower = 0;
            if (!battle)
                return;
            // Continuous emitters: projectile trails, beam impact sparks, charge convergence, clash sparks.
            for (const p of battle.projectiles) {
                this.spawn(0 /* Kind.Spark */, p.x, p.y, p.z, this.rng.range(-3, 3), this.rng.range(-2, 3), this.rng.range(-3, 3), 0.3, p.radius * 0.45, p.color, 0, 3);
            }
            for (const b of battle.beams) {
                this.beamPower += b.power;
                if (b.clashing)
                    continue;
                const hitting = b.drawLength < b.length - 0.5;
                if (hitting) {
                    const x = b.originX + b.dirX * b.drawLength;
                    const z = b.originZ + b.dirZ * b.drawLength;
                    this.sparks(x, b.originY, z, 2, 18, b.def.color, 0.3, 0.3);
                }
            }
            if (battle.clash) {
                const c = battle.clash;
                this.sparks(c.x, c.y, c.z, 3, 22, [1, 1, 1], 0.4, 0.35);
                this.sparks(c.x, c.y, c.z, 2, 18, c.a.def.color, 0.4, 0.3);
                this.sparks(c.x, c.y, c.z, 2, 18, c.b.def.color, 0.4, 0.3);
                this.beamPower += 1;
            }
            for (const f of battle.fighters) {
                if (f.state === 'charge') {
                    const c = f.def.moves.beam.color;
                    const a = this.rng.range(0, Math.PI * 2);
                    const rr = 6 + this.rng.range(0, 4);
                    const cx = f.x + f.forwardX * f.radius;
                    const cz = f.z + f.forwardZ * f.radius;
                    const cy = f.y + f.height * 0.62;
                    this.spawn(0 /* Kind.Spark */, cx + Math.cos(a) * rr, cy + this.rng.range(-3, 3), cz + Math.sin(a) * rr, -Math.cos(a) * rr * 3, 0, -Math.sin(a) * rr * 3, 0.33, 0.3, c);
                }
                this.emitUltimate(f);
                this.emitTransform(f);
                if (f.state === 'launched' && f.y > 0.5 && this.rng.chance(0.4)) {
                    this.spawn(3 /* Kind.Smoke */, f.x, f.y + f.height * 0.5, f.z, 0, 1, 0, 0.5, 1.4, [0.8, 0.8, 0.8], 0, 2, 2);
                }
            }
        }
        /** Probability factor so every continuous emitter honours the graphics quality setting. */
        get density() {
            return this.quality === 'high' ? 1 : this.quality === 'medium' ? 0.6 : 0.35;
        }
        /** Charge-up and rush effects of an ultimate. Each kind of ultimate has its own look. */
        emitUltimate(f) {
            const u = f.ultimate;
            const a = f.attack;
            if (!u || !a || f.state !== 'attack')
                return;
            const rng = this.rng;
            const k = (0, math_js_10.saturate)(f.attackTime / Math.max(0.1, a.startup));
            const cx = f.x + f.forwardX * f.radius * 1.1;
            const cz = f.z + f.forwardZ * f.radius * 1.1;
            const cy = f.y + f.height * 0.6;
            if (f.attackTime < a.startup) {
                if (!rng.chance((0.35 + 0.65 * k) * this.density))
                    return;
                const ang = rng.range(0, Math.PI * 2);
                if (u.kind === 'beam' || u.kind === 'projectile') {
                    // sparks spiral in toward the hands, tighter and faster as the charge builds
                    const rr = (9 - 5 * k) + rng.range(0, 3);
                    this.spawn(0 /* Kind.Spark */, cx + Math.cos(ang) * rr, cy + rng.range(-3, 3), cz + Math.sin(ang) * rr, -Math.cos(ang) * rr * 3.4, 0, -Math.sin(ang) * rr * 3.4, 0.33, 0.35, k > 0.7 ? u.coreColor : u.color);
                }
                else if (u.kind === 'shockwave') {
                    // the ground heaves: rising debris and dust around the feet, ring pulses
                    const rr = f.radius * rng.range(0.8, 2.4);
                    this.spawn(2 /* Kind.Debris */, f.x + Math.cos(ang) * rr, 0.3, f.z + Math.sin(ang) * rr, 0, rng.range(6, 12 + 8 * k), 0, rng.range(0.6, 1.1), 0.35 + 0.3 * k, [0.55, 0.42, 0.3], 22, 0.05);
                    if (rng.chance(0.3))
                        this.spawn(1 /* Kind.Dust */, f.x + Math.cos(ang) * rr, 0.5, f.z + Math.sin(ang) * rr, Math.cos(ang) * 4, 2, Math.sin(ang) * 4, 0.9, 2.2, [0.6, 0.52, 0.45], -0.5, 1.6, 2.2);
                    if (rng.chance(0.06))
                        this.ring(f.x, 0.25, f.z, f.radius, f.radius * (3 + 3 * k), 0.5, u.color, true);
                }
                else {
                    // finisher: tight whirl of speed streaks around the body
                    const rr = f.radius * rng.range(1.4, 2.2);
                    this.spawn(0 /* Kind.Spark */, f.x + Math.cos(ang) * rr, f.y + rng.range(0.5, f.height * 0.9), f.z + Math.sin(ang) * rr, -Math.sin(ang) * 22, rng.range(-2, 6), Math.cos(ang) * 22, 0.3, 0.3, u.color, 0, 2);
                }
            }
            else if (u.kind === 'finisher') {
                // the rush leaves a bright trail
                for (let i = 0; i < 2; i++) {
                    if (!rng.chance(this.density))
                        continue;
                    this.spawn(0 /* Kind.Spark */, f.x + rng.range(-1.2, 1.2), f.y + rng.range(1, f.height * 0.9), f.z + rng.range(-1.2, 1.2), -f.forwardX * 10, rng.range(-1, 2), -f.forwardZ * 10, 0.4, 0.5, rng.chance(0.4) ? u.coreColor : u.color);
                }
            }
        }
        /** Rising energy while a fighter is changing form. */
        emitTransform(f) {
            if (f.state !== 'transform')
                return;
            const rng = this.rng;
            const form = f.baseDef.forms?.[f.pendingForm];
            const c = form?.aura ?? f.baseDef.rig.colors.glow;
            const u = (0, math_js_10.saturate)(f.stateTime / Math.max(0.2, form?.windup ?? 1.1));
            if (!rng.chance((0.5 + 0.5 * u) * this.density))
                return;
            const ang = rng.range(0, Math.PI * 2);
            const rr = f.radius * rng.range(1.2, 2.4);
            this.spawn(0 /* Kind.Spark */, f.x + Math.cos(ang) * rr, f.y + 0.4, f.z + Math.sin(ang) * rr, Math.cos(ang) * -2, 8 + 14 * u, Math.sin(ang) * -2, 0.7, 0.35 + 0.2 * u, c);
            if (rng.chance(0.05))
                this.ring(f.x, 0.3, f.z, f.radius, f.radius * (3 + 4 * u), 0.55, c, true);
        }
        // --------------------------------------------------------------------- draw
        draw(r, battle, time) {
            const st = this.stack;
            let n = 0;
            // --- beams, projectiles, charge orbs, clash orb
            if (battle) {
                for (const b of battle.beams) {
                    const len = Math.max(0.5, b.drawLength);
                    const w = b.def.width * 0.5 * (b.clashing ? 1.15 : 1) * (1 + 0.1 * Math.sin(time * 70 + b.owner));
                    const fade = (0, math_js_10.saturate)(b.timeLeft / 0.25);
                    // Very wide beams (ultimates) get thinner, tinted layers: additive blending of a wide white core would
                    // otherwise wash out both fighters and make the fight unreadable.
                    const wide = (0, math_js_10.saturate)((b.def.width - 4) / 3.5);
                    const core = this.tint;
                    const k = wide * 0.45;
                    core[0] = (0, math_js_10.lerp)(b.def.coreColor[0], b.def.color[0], k);
                    core[1] = (0, math_js_10.lerp)(b.def.coreColor[1], b.def.color[1], k);
                    core[2] = (0, math_js_10.lerp)(b.def.coreColor[2], b.def.color[2], k);
                    this.beamLayer(r, b.originX, b.originY, b.originZ, b.yaw, len, w * (0, math_js_10.lerp)(1.9, 1.3, wide), b.def.color, (0, math_js_10.lerp)(0.28, 0.2, wide) * fade);
                    this.beamLayer(r, b.originX, b.originY, b.originZ, b.yaw, len, w * (0, math_js_10.lerp)(1.15, 0.8, wide), b.def.color, (0, math_js_10.lerp)(0.65, 0.4, wide) * fade);
                    this.beamLayer(r, b.originX, b.originY, b.originZ, b.yaw, len, w * (0, math_js_10.lerp)(0.55, 0.32, wide), core, (0, math_js_10.lerp)(0.95, 0.85, wide) * fade);
                    this.orb(r, b.originX, b.originY, b.originZ, w * (0, math_js_10.lerp)(2.2, 1.3, wide) * (0.8 + 0.2 * Math.sin(time * 50)), b.def.color, (0, math_js_10.lerp)(0.8, 0.45, wide));
                    if (b.drawLength < b.length - 0.5 && !b.clashing) {
                        this.orb(r, b.originX + b.dirX * len, b.originY, b.originZ + b.dirZ * len, w * (0, math_js_10.lerp)(2.4, 0.9, wide) * (0.8 + 0.2 * Math.sin(time * 61)), core, (0, math_js_10.lerp)(0.7, 0.3, wide));
                    }
                    n += 5;
                }
                for (const p of battle.projectiles) {
                    this.orb(r, p.x, p.y, p.z, p.radius * 1.8, p.color, 0.5);
                    this.orb(r, p.x, p.y, p.z, p.radius * 0.9, [1, 1, 1], 0.95);
                    n += 2;
                }
                if (battle.clash) {
                    const c = battle.clash;
                    const pulse = 0.85 + 0.15 * Math.sin(time * 40);
                    this.orb(r, c.x, c.y, c.z, (5 + (c.powerA + c.powerB) * 0.5) * pulse, [1, 1, 1], 0.5);
                    this.orb(r, c.x, c.y, c.z, (3 + (c.powerA + c.powerB) * 0.3) * pulse, c.balance > 0.5 ? c.a.def.color : c.b.def.color, 0.85);
                    n += 2;
                }
                for (const f of battle.fighters) {
                    // Ultimate build-up: a pulsing body aura plus a growing orb at the hands (beam / projectile kinds).
                    const ua = f.attack;
                    if (f.ultimate && ua && f.state === 'attack' && f.attackTime < ua.startup) {
                        const u = f.ultimate;
                        const k = (0, math_js_10.saturate)(f.attackTime / Math.max(0.1, ua.startup));
                        const pulse = 0.9 + 0.1 * Math.sin(time * (18 + 20 * k));
                        this.orb(r, f.x, f.y + f.height * 0.5, f.z, f.height * (0.5 + 0.4 * k) * pulse, u.color, 0.1 + 0.2 * k);
                        this.orb(r, f.x, f.y + f.height * 0.5, f.z, f.height * (0.3 + 0.2 * k), u.coreColor, 0.06 + 0.1 * k);
                        if (u.kind === 'beam' || u.kind === 'projectile') {
                            const hx = f.x + f.forwardX * f.radius * 1.2;
                            const hz = f.z + f.forwardZ * f.radius * 1.2;
                            const s = (1 + k * (u.kind === 'projectile' ? 5.5 : 4.5)) * pulse;
                            this.orb(r, hx, f.y + f.height * 0.6, hz, s * 1.7, u.color, 0.3);
                            this.orb(r, hx, f.y + f.height * 0.6, hz, s, u.coreColor, 0.85);
                            n += 2;
                        }
                        n += 2;
                    }
                    // Transformation: an expanding aura that peaks right before the final burst.
                    if (f.state === 'transform') {
                        const form = f.baseDef.forms?.[f.pendingForm];
                        const c = form?.aura ?? f.baseDef.rig.colors.glow;
                        const u = (0, math_js_10.saturate)(f.stateTime / Math.max(0.2, form?.windup ?? 1.1));
                        const pulse = 0.92 + 0.08 * Math.sin(time * 30);
                        this.orb(r, f.x, f.y + f.height * 0.5, f.z, f.height * (0.45 + 0.65 * u) * pulse, c, 0.14 + 0.32 * u);
                        this.orb(r, f.x, f.y + f.height * 0.5, f.z, f.height * (0.25 + 0.3 * u), [1, 1, 1], 0.08 + 0.2 * u);
                        n += 2;
                    }
                    // Ultimate ready: a faint, slow glow (the bright pop happens once, in the HUD and as a ring).
                    if (f.ultReady && (f.state === 'idle' || f.state === 'walk')) {
                        const c = f.def.moves.ultimate.color;
                        this.orb(r, f.x, f.y + f.height * 0.5, f.z, f.height * 0.55, c, 0.045 + 0.035 * (0.5 + 0.5 * Math.sin(time * 2.4)));
                        n++;
                    }
                    if (f.state === 'charge') {
                        const def = f.def.moves.beam;
                        const k = (0, math_js_10.saturate)(f.chargeTime / def.maxCharge);
                        const cx = f.x + f.forwardX * f.radius * 1.1;
                        const cz = f.z + f.forwardZ * f.radius * 1.1;
                        const cy = f.y + f.height * 0.62;
                        const s = (1.2 + k * 3.2) * (0.9 + 0.1 * Math.sin(time * 45));
                        this.orb(r, cx, cy, cz, s * 1.6, def.color, 0.35);
                        this.orb(r, cx, cy, cz, s, def.coreColor, 0.85);
                        n += 2;
                    }
                }
            }
            // --- flashes + rings
            for (const f of this.flashes) {
                if (!f.on)
                    continue;
                const t = 1 - f.life / f.max;
                this.orb(r, f.x, f.y, f.z, f.size * (0, math_js_10.lerp)(0.6, 1.3, t), [f.r, f.g, f.b], (1 - t) * 0.9);
                n++;
            }
            for (const rg of this.rings) {
                if (!rg.on)
                    continue;
                const t = 1 - rg.life / rg.max;
                const rad = (0, math_js_10.lerp)(rg.r0, rg.r1, 1 - (1 - t) * (1 - t));
                const m = (0, Renderer_js_3.resetMaterial)(this.mat);
                m.mode = 3;
                m.additive = true;
                m.alpha = (1 - t) * 0.85;
                m.color[0] = rg.r;
                m.color[1] = rg.g;
                m.color[2] = rg.b;
                st.reset().translate(rg.x, rg.y, rg.z);
                if (rg.flat)
                    st.scale(rad, 1, rad);
                else
                    st.rotY(rg.yaw).rotX(Math.PI / 2).scale(rad, 1, rad);
                r.draw(r.meshes.ring, st.m, m);
                n++;
            }
            // --- particles
            for (const p of this.parts) {
                if (!p.on)
                    continue;
                const t = p.life / p.max;
                const m = (0, Renderer_js_3.resetMaterial)(this.mat);
                m.color[0] = p.r;
                m.color[1] = p.g;
                m.color[2] = p.b;
                st.reset().translate(p.x, p.y, p.z);
                if (p.kind === 0 /* Kind.Spark */) {
                    m.mode = 3;
                    m.additive = true;
                    m.alpha = (0, math_js_10.saturate)(t * 1.6);
                    st.scale(p.size * (0.5 + t), p.size * (0.5 + t), p.size * (0.5 + t));
                    r.draw(r.meshes.sphere, st.m, m);
                }
                else if (p.kind === 2 /* Kind.Debris */) {
                    st.rotY(p.rot).rotX(p.rot * 0.7).scale(p.size, p.size * 0.7, p.size);
                    r.draw(r.meshes.cube, st.m, m);
                }
                else {
                    m.mode = 4;
                    m.alpha = (0, math_js_10.saturate)(t) * (p.kind === 1 /* Kind.Dust */ ? 0.42 : 0.3);
                    st.scale(p.size, p.size * 0.8, p.size);
                    r.draw(r.meshes.sphere, st.m, m);
                }
                n++;
            }
            this.activeCount = n;
        }
        beamLayer(r, x, y, z, yaw, len, width, c, alpha) {
            const m = (0, Renderer_js_3.resetMaterial)(this.mat);
            m.mode = 3;
            m.additive = true;
            m.alpha = alpha;
            m.color[0] = c[0];
            m.color[1] = c[1];
            m.color[2] = c[2];
            this.stack.reset().translate(x, y, z).rotY(yaw).rotX(Math.PI / 2).scale(width, len, width);
            r.draw(r.meshes.beam, this.stack.m, m);
        }
        orb(r, x, y, z, size, c, alpha) {
            const m = (0, Renderer_js_3.resetMaterial)(this.mat);
            m.mode = 3;
            m.additive = true;
            m.alpha = alpha;
            m.color[0] = c[0];
            m.color[1] = c[1];
            m.color[2] = c[2];
            this.stack.reset().translate(x, y, z).scale(size, size, size);
            r.draw(r.meshes.sphere, this.stack.m, m);
        }
    }
    exports.VFX = VFX;
});
define("app/Match", ["require", "exports", "combat/Battle"], function (require, exports, Battle_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Match = exports.KO_TIME = exports.FIGHT_CALL_AT = exports.INTRO_TIME = void 0;
    exports.INTRO_TIME = 2.4;
    exports.FIGHT_CALL_AT = 1.5;
    exports.KO_TIME = 3.0;
    /** Round flow, timer and win conditions around a Battle. Renderer-free. */
    class Match {
        battle;
        cfg;
        phase = 'intro';
        phaseTime = 0;
        round = 1;
        wins = [0, 0];
        clock;
        /** Total seconds spent in fight phases. */
        elapsed = 0;
        lastOutcome = null;
        /** 0 / 1 = winner, -1 = draw, undefined while undecided. */
        matchWinner;
        onPhase = null;
        fightCalled = false;
        constructor(cfg) {
            this.cfg = cfg;
            const practice = cfg.mode === 'practice';
            this.battle = new Battle_js_1.Battle([cfg.p1, cfg.p2], cfg.stage, {
                seed: cfg.seed ?? 1,
                infiniteHp: practice ? [true, true] : [false, false],
                infiniteEnergy: cfg.infiniteEnergy ? [true, true] : [false, false],
            });
            this.clock = cfg.mode === 'practice' ? 0 : cfg.time;
            this.setPhase('intro');
        }
        get roundsToWin() {
            return Math.ceil(this.cfg.rounds / 2);
        }
        get hasTimer() {
            return this.cfg.mode !== 'practice' && this.cfg.time > 0;
        }
        /** True once "FIGHT!" should be shown (the intro's second half). */
        get fightCalled_() {
            return this.fightCalled;
        }
        setPhase(p) {
            this.phase = p;
            this.phaseTime = 0;
            this.battle.controlsEnabled = p === 'fight';
            this.onPhase?.(p, this);
        }
        /** Advance the match. `inputs` are only honoured during the fight phase. */
        step(dt, inputs) {
            this.phaseTime += dt;
            switch (this.phase) {
                case 'intro':
                    this.battle.step(dt, inputs);
                    if (!this.fightCalled && this.phaseTime >= exports.FIGHT_CALL_AT)
                        this.fightCalled = true;
                    if (this.phaseTime >= exports.INTRO_TIME)
                        this.setPhase('fight');
                    break;
                case 'fight':
                    this.battle.step(dt, inputs);
                    this.elapsed += dt;
                    if (this.hasTimer)
                        this.clock = Math.max(0, this.clock - dt);
                    this.checkRoundEnd();
                    break;
                case 'ko':
                    this.battle.step(dt, inputs);
                    if (this.phaseTime >= exports.KO_TIME)
                        this.nextRoundOrFinish();
                    break;
                case 'over':
                    this.battle.step(dt, inputs);
                    break;
            }
        }
        checkRoundEnd() {
            const b = this.battle;
            let w = b.roundWinner();
            let timeout = false;
            if (w === undefined && this.hasTimer && this.clock <= 0) {
                const [a, c] = b.fighters;
                const pa = a.hp / a.stats.maxHp;
                const pc = c.hp / c.stats.maxHp;
                w = Math.abs(pa - pc) < 1e-6 ? -1 : pa > pc ? 0 : 1;
                timeout = true;
            }
            if (w === undefined)
                return;
            const loser = w === -1 ? -1 : 1 - w;
            const perfect = w >= 0 && b.fighters[w].hp >= b.fighters[w].stats.maxHp - 0.001;
            this.lastOutcome = { winner: w, timeout, perfect };
            if (w === -1) {
                this.wins[0]++;
                this.wins[1]++;
            }
            else {
                this.wins[w]++;
                b.setVictory(w);
                if (timeout && loser >= 0) {
                    // Time-over losers just stand down; no KO animation.
                    const l = b.fighters[loser];
                    if (l.alive && l.state !== 'victory')
                        l.setState('idle');
                }
            }
            this.setPhase('ko');
        }
        nextRoundOrFinish() {
            const target = this.roundsToWin;
            const [a, b] = this.wins;
            if (a >= target || b >= target || this.round >= this.cfg.rounds + 2) {
                this.matchWinner = a === b ? -1 : a > b ? 0 : 1;
                this.setPhase('over');
                return;
            }
            this.round++;
            this.battle.resetRound();
            this.clock = this.cfg.time;
            this.fightCalled = false;
            this.setPhase('intro');
        }
        /** Practice helper: put both fighters back at the start positions with full resources. */
        resetPositions() {
            this.battle.resetRound();
            this.battle.controlsEnabled = true;
        }
        /** Performance rank for single-player matches (S best .. D). Pure function of match stats. */
        rank() {
            const p1 = this.battle.fighters[0];
            const taken = p1.damageTaken / Math.max(1, p1.stats.maxHp * Math.max(1, this.wins[0] + this.wins[1]));
            let score = 50;
            score += Math.max(0, 40 - this.elapsed / Math.max(1, this.wins[0] + this.wins[1])) * 0.8;
            score -= taken * 45;
            score += Math.min(10, p1.maxCombo * 2);
            score += p1.counters * 3;
            if (this.matchWinner !== 0)
                score -= 30;
            return score >= 85 ? 'S' : score >= 70 ? 'A' : score >= 55 ? 'B' : score >= 40 ? 'C' : 'D';
        }
    }
    exports.Match = Match;
});
define("ui/strings", ["require", "exports"], function (require, exports) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.setLanguage = setLanguage;
    exports.t = t;
    // Language-ready text: every UI label goes through t(). Add another table + setLanguage() to localise.
    const EN = {
        'title.main': 'ULTRA FIGHTING EVOLUTION',
        'title.sub': 'ULTIMATE',
        'menu.vscpu': 'VS CPU',
        'menu.vs2p': 'LOCAL VS (2 PLAYERS)',
        'menu.battle': 'BATTLE MODE',
        'menu.practice': 'PRACTICE',
        'menu.controls': 'CONTROLS',
        'menu.options': 'OPTIONS',
        'menu.records': 'RECORDS',
        'menu.footer': 'Fan-inspired prototype. All fighters, names and art are original placeholders.',
        'select.p1': 'PLAYER 1',
        'select.p2': 'PLAYER 2',
        'select.cpu': 'OPPONENT (CPU)',
        'select.dummy': 'TRAINING DUMMY',
        'select.stage': 'STAGE',
        'select.start': 'START',
        'select.back': 'BACK',
        'select.random': 'RANDOM',
        'select.locked': 'PLANNED - NOT PLAYABLE',
        'pause.title': 'PAUSED',
        'pause.resume': 'RESUME',
        'pause.restart': 'RESTART MATCH',
        'pause.reset': 'RESET POSITIONS',
        'pause.quit': 'QUIT TO MENU',
        'result.win': 'VICTORY',
        'result.lose': 'DEFEAT',
        'result.draw': 'DRAW',
        'result.rematch': 'REMATCH',
        'result.change': 'CHANGE FIGHTERS',
        'result.menu': 'MAIN MENU',
        'result.next': 'NEXT FIGHT',
        'result.retry': 'RETRY FIGHT',
        'hud.round': 'ROUND',
        'hud.fight': 'FIGHT!',
        'hud.ko': 'K.O.',
        'hud.timeover': 'TIME OVER',
        'hud.draw': 'DRAW',
        'hud.perfect': 'PERFECT',
        'hud.clash': 'BEAM CLASH - MASH THE BEAM BUTTON!',
        'hud.counter': 'COUNTER!',
        'hud.guardbreak': 'GUARD BREAK!',
        'hud.techbreak': 'THROW ESCAPE!',
        'hud.powerlow': 'POWER TIMER EMPTY',
        'hud.transform': 'TRANSFORM!',
        'hud.revert': 'FORM ENDED',
        'options.title': 'OPTIONS',
        'back': 'BACK',
    };
    let table = EN;
    function setLanguage(t) {
        table = { ...EN, ...t };
    }
    function t(key) {
        return table[key] ?? key;
    }
});
define("ui/BattleHUD", ["require", "exports", "characters/TransformationSystem", "math", "ui/strings"], function (require, exports, TransformationSystem_js_4, math_js_11, strings_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.BattleHUD = void 0;
    const SIDE_HTML = `
  <div class="name"></div>
  <div class="hp"><i class="lag"></i><i class="fill"></i></div>
  <div class="gauges">
    <div class="en" title="Energy (the marker shows the ultimate cost)"><i></i><b class="mark"></b></div>
    <div class="gd" title="Guard"><i></i></div>
  </div>
  <div class="ult"><span>ULT</span><small></small></div>
  <div class="tm"><span>POWER</span><div><i></i></div></div>
  <div class="pips"></div>`;
    /** DOM HUD driven directly from simulation state, so it can never disagree with what is happening in the fight. */
    class BattleHUD {
        root;
        sides;
        timer;
        round;
        banner;
        clash;
        clashFill;
        feed;
        practice;
        flashEl;
        touchUlt;
        touchForm;
        bannerKey = '';
        lastCombo = { hits: 0, dmg: 0 };
        constructor(root) {
            this.root = root;
            root.innerHTML = `
      <div class="hud-top">
        <div class="fside left" id="hud-p1">${SIDE_HTML}</div>
        <div class="hud-center"><div id="hud-timer">99</div><div id="hud-round"></div></div>
        <div class="fside right" id="hud-p2">${SIDE_HTML}</div>
      </div>
      <div class="combo left" id="hud-combo-0"></div>
      <div class="combo right" id="hud-combo-1"></div>
      <div id="hud-clash" class="hidden"><div class="clash-bar"><i></i></div><div class="clash-txt">${(0, strings_js_1.t)('hud.clash')}</div></div>
      <div id="fx-flash"></div>
      <div id="hud-banner"></div>
      <div id="hud-feed"></div>
      <div id="hud-practice" class="hidden"></div>`;
            const q = (sel) => root.querySelector(sel);
            const mk = (id, comboId) => {
                const el = q(id);
                return {
                    root: el,
                    name: el.querySelector('.name'),
                    hp: el.querySelector('.hp'),
                    fill: el.querySelector('.hp .fill'),
                    lag: el.querySelector('.hp .lag'),
                    en: el.querySelector('.en i'),
                    gd: el.querySelector('.gd i'),
                    tm: el.querySelector('.tm i'),
                    tmWrap: el.querySelector('.tm'),
                    pips: el.querySelector('.pips'),
                    combo: q(comboId),
                    mark: el.querySelector('.en .mark'),
                    ult: el.querySelector('.ult'),
                    ultState: '',
                    lagValue: 1, lastHp: 1, lastName: '', lastPips: '',
                };
            };
            this.sides = [mk('#hud-p1', '#hud-combo-0'), mk('#hud-p2', '#hud-combo-1')];
            this.timer = q('#hud-timer');
            this.round = q('#hud-round');
            this.banner = q('#hud-banner');
            this.clash = q('#hud-clash');
            this.clashFill = q('#hud-clash .clash-bar i');
            this.feed = q('#hud-feed');
            this.practice = q('#hud-practice');
            this.flashEl = q('#fx-flash');
        }
        show(on) {
            this.root.classList.toggle('hidden', !on);
        }
        /** Reset trailing values when a new battle starts. */
        reset() {
            for (const s of this.sides) {
                s.lagValue = 1;
                s.lastHp = 1;
                s.lastName = '';
                s.lastPips = '';
                s.ultState = '';
            }
            this.bannerKey = '';
            this.lastCombo = { hits: 0, dmg: 0 };
            this.feed.innerHTML = '';
        }
        /** One bright pop on the energy bar when the ultimate becomes available (not a constant flash). */
        pulseUltimate(i) {
            const bar = this.sides[i].en.parentElement;
            if (!bar)
                return;
            bar.classList.remove('ult-pop');
            void bar.offsetWidth;
            bar.classList.add('ult-pop');
        }
        /** Full-screen colour flash that fades out on its own. Callers skip it when effects are reduced. */
        flash(c, strength) {
            const el = this.flashEl;
            el.style.transition = 'none';
            el.style.background = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
            el.style.opacity = String((0, math_js_11.clamp)(strength, 0, 0.7));
            void el.offsetWidth;
            el.style.transition = 'opacity 0.45s ease-out';
            el.style.opacity = '0';
        }
        /** Short floating message (counter, guard break...). Auto-removed; capped so it can't pile up. */
        message(text, cls = '') {
            while (this.feed.childElementCount >= 4)
                this.feed.firstElementChild?.remove();
            const el = document.createElement('div');
            el.className = `msg ${cls}`;
            el.textContent = text;
            this.feed.appendChild(el);
            window.setTimeout(() => el.remove(), 1400);
        }
        update(match, dt) {
            const b = match.battle;
            for (let i = 0; i < 2; i++)
                this.updateSide(this.sides[i], b.fighters[i], match, i, dt);
            this.timer.textContent = match.hasTimer ? String(Math.ceil(match.clock)) : match.cfg.mode === 'practice' ? '∞' : '--';
            this.timer.classList.toggle('low', match.hasTimer && match.clock <= 10);
            this.round.textContent = match.cfg.mode === 'practice' ? 'PRACTICE' : `${(0, strings_js_1.t)('hud.round')} ${match.round}`;
            // Beam clash advantage indicator
            const c = b.clash;
            this.clash.classList.toggle('hidden', !c);
            if (c) {
                // balance 1 = player 1's beam has pushed all the way to player 2.
                this.clashFill.style.width = `${(0, math_js_11.clamp)(c.balance, 0, 1) * 100}%`;
            }
            // Banner (round call / KO)
            let key = '';
            let text = '';
            let cls = '';
            if (match.phase === 'intro') {
                key = match.fightCalled_ ? 'fight' : `round${match.round}`;
                text = match.fightCalled_ ? (0, strings_js_1.t)('hud.fight') : match.cfg.mode === 'practice' ? 'PRACTICE' : `${(0, strings_js_1.t)('hud.round')} ${match.round}`;
                cls = match.fightCalled_ ? 'fight' : 'round';
            }
            else if (match.phase === 'ko' && match.lastOutcome) {
                const o = match.lastOutcome;
                key = `ko${match.round}`;
                text = o.winner === -1 ? (0, strings_js_1.t)('hud.draw') : o.timeout ? (0, strings_js_1.t)('hud.timeover') : o.perfect ? (0, strings_js_1.t)('hud.perfect') : (0, strings_js_1.t)('hud.ko');
                cls = 'ko';
            }
            if (key !== this.bannerKey) {
                this.bannerKey = key;
                this.banner.textContent = text;
                this.banner.className = text ? `show ${cls}` : '';
            }
            if (match.cfg.mode === 'practice')
                this.updatePractice(match);
            else
                this.practice.classList.add('hidden');
        }
        updateSide(s, f, match, i, dt) {
            const hp = (0, math_js_11.clamp)(f.hp / f.stats.maxHp, 0, 1);
            s.fill.style.width = `${hp * 100}%`;
            // Damage trail: holds, then catches up.
            if (hp > s.lagValue)
                s.lagValue = hp;
            else
                s.lagValue = (0, math_js_11.damp)(s.lagValue, hp, 2.2, dt);
            s.lag.style.width = `${s.lagValue * 100}%`;
            s.hp.classList.toggle('critical', hp < 0.25 && hp > 0);
            const label = f.formName ? `${f.def.name} \u00b7 ${f.formName}` : f.def.name;
            if (s.lastName !== label) {
                s.name.textContent = label;
                s.lastName = label;
            }
            const beam = f.def.moves.beam;
            // ---- ultimate: threshold marker on the energy bar + a state chip (locked / ready / cooling / active)
            const ult = f.def.moves.ultimate;
            const need = (0, math_js_11.clamp)(ult.energyCost / f.stats.maxEnergy, 0, 1);
            s.mark.style[i === 1 ? 'right' : 'left'] = `${need * 100}%`;
            const ultReady = f.ultimate === null && f.ultimateCooldown <= 0 && f.energy >= ult.energyCost;
            const ultKey = f.ultimate ? 'active' : f.ultimateCooldown > 0 ? 'cool' : ultReady ? 'ready' : 'locked';
            const chipText = ultKey === 'active' ? ult.name.toUpperCase()
                : ultKey === 'cool' ? `${f.ultimateCooldown.toFixed(1)}s`
                    : ultKey === 'ready' ? `${ult.name.toUpperCase()} READY`
                        : `${Math.floor(f.energy)}/${ult.energyCost}`;
            if (s.ult.dataset.k !== ultKey || ultKey === 'cool' || ultKey === 'locked') {
                s.ult.dataset.k = ultKey;
                s.ult.className = `ult ${ultKey}`;
                s.ult.lastElementChild.textContent = chipText;
            }
            s.en.parentElement?.classList.toggle('ult-ready', ultKey === 'ready');
            if (i === 0)
                this.updateTouchButtons(f, ultKey);
            s.en.style.width = `${(0, math_js_11.clamp)(f.energy / f.stats.maxEnergy, 0, 1) * 100}%`;
            s.en.parentElement?.classList.toggle('ready', f.energy >= beam.energyCost);
            s.gd.style.width = `${(0, math_js_11.clamp)(f.guard / f.stats.maxGuard, 0, 1) * 100}%`;
            s.gd.parentElement?.classList.toggle('low', f.guard < f.stats.maxGuard * 0.3);
            s.gd.parentElement?.classList.toggle('broken', f.guard < 1);
            const timer = f.def.timer;
            s.tmWrap.classList.toggle('hidden', !timer);
            if (timer) {
                s.tm.style.width = `${(0, math_js_11.clamp)(f.timerLeft / timer.seconds, 0, 1) * 100}%`;
                s.tmWrap.classList.toggle('low', f.timerExpired || f.timerLeft < timer.seconds * 0.25);
            }
            const pipKey = `${match.wins[i]}/${match.roundsToWin}`;
            if (s.lastPips !== pipKey && match.cfg.mode !== 'practice') {
                s.lastPips = pipKey;
                let html = '';
                for (let k = 0; k < match.roundsToWin; k++)
                    html += `<b class="${k < match.wins[i] ? 'on' : ''}"></b>`;
                s.pips.innerHTML = html;
            }
            else if (match.cfg.mode === 'practice') {
                s.pips.innerHTML = '';
                s.lastPips = '';
            }
            // Combo counter shows on the attacker's side: hits the *opponent* has taken in this string.
            const opp = match.battle.fighters[1 - i];
            const hits = opp.comboTimer > 0 || opp.state === 'hitstun' || opp.state === 'launched' ? opp.hitsTaken : 0;
            if (hits >= 2) {
                const txt = `${hits} HITS`;
                const tier = hits >= 12 ? 'tier4' : hits >= 8 ? 'tier3' : hits >= 5 ? 'tier2' : 'tier1';
                const word = hits >= 12 ? 'BRUTAL!' : hits >= 8 ? 'GREAT!' : hits >= 5 ? 'NICE' : '';
                s.combo.classList.remove('tier1', 'tier2', 'tier3', 'tier4');
                s.combo.classList.add(tier);
                if (s.combo.dataset.v !== txt) {
                    s.combo.dataset.v = txt;
                    s.combo.innerHTML = `<b>${hits}</b> HITS<small>${Math.round(opp.comboDamage)} dmg ${word}</small>`;
                    s.combo.classList.remove('pop');
                    void s.combo.offsetWidth;
                    s.combo.classList.add('pop');
                }
                s.combo.classList.add('on');
            }
            else {
                s.combo.classList.remove('on');
                s.combo.dataset.v = '';
            }
        }
        /** Light up the touch ULT / FORM buttons when the action is actually available (player 1 only). */
        updateTouchButtons(f, ultKey) {
            if (this.touchUlt === undefined)
                this.touchUlt = document.querySelector('[data-btn="ult"]');
            if (this.touchForm === undefined)
                this.touchForm = document.querySelector('[data-btn="form"]');
            const set = (el, state) => {
                if (!el || el.dataset.k === state)
                    return;
                el.dataset.k = state;
                el.classList.remove('ready', 'cool', 'active');
                if (state)
                    el.classList.add(state);
            };
            set(this.touchUlt, ultKey === 'locked' ? 'cool' : ultKey);
            const hasForms = (f.baseDef.forms?.length ?? 0) > 0;
            set(this.touchForm, !hasForms ? 'cool' : f.state === 'transform' ? 'active' : (0, TransformationSystem_js_4.canTransform)(f) ? 'ready' : 'cool');
        }
        updatePractice(match) {
            const p1 = match.battle.fighters[0];
            const p2 = match.battle.fighters[1];
            if (p2.hitsTaken >= 1)
                this.lastCombo = { hits: p2.hitsTaken, dmg: p2.comboDamage };
            this.practice.classList.remove('hidden');
            this.practice.innerHTML =
                `<div>Last combo: <b>${this.lastCombo.hits}</b> hits / <b>${Math.round(this.lastCombo.dmg)}</b> damage</div>` +
                    `<div>Dealt: <b>${Math.round(p1.damageDealt)}</b> &nbsp; Max combo: <b>${p1.maxCombo}</b> &nbsp; Counters: <b>${p1.counters}</b></div>`;
        }
    }
    exports.BattleHUD = BattleHUD;
});
define("ui/Screens", ["require", "exports", "app/SaveManager", "characters/CharacterRegistry", "data/stages", "input/InputManager", "ui/strings"], function (require, exports, SaveManager_js_1, CharacterRegistry_js_1, stages_js_3, InputManager_js_1, strings_js_2) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Screens = void 0;
    const rgb = (c, k = 1) => `rgb(${Math.round(Math.min(1, c[0] * k) * 255)},${Math.round(Math.min(1, c[1] * k) * 255)},${Math.round(Math.min(1, c[2] * k) * 255)})`;
    const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const MODE_TITLES = {
        'vs-cpu': 'VS CPU', 'vs-2p': 'LOCAL VS', battle: 'BATTLE MODE', practice: 'PRACTICE', online: 'ONLINE',
    };
    const ACTION_LABEL = {
        up: 'Move forward', down: 'Move back', left: 'Step left', right: 'Step right', light: 'Light attack',
        heavy: 'Heavy attack', special: 'Special', beam: 'Beam (hold to charge)', guard: 'Guard', jump: 'Jump',
        dodge: 'Dodge', grab: 'Grab / throw', alt: 'Transform', ultimate: 'Ultimate',
    };
    const ACTION_NAMES = {
        light: 'Light', heavy: 'Heavy', special: 'Special', beam: 'Beam', guard: 'Guard', jump: 'Jump',
        dodge: 'Dodge', grab: 'Grab', alt: 'Transform', ultimate: 'Ultimate', pause: 'Pause',
    };
    const TOUCH_GLYPH = {
        square: '□', triangle: '△', cross: '✕', circle: '○', l1: 'L1', r1: 'R1', l2: 'L2', r2: 'R2', form: 'FORM', ult: 'ULT',
    };
    /** All menu screens. Plain DOM + one delegated click/input handler, so every screen works with touch or mouse. */
    class Screens {
        root;
        save;
        input;
        cb;
        current = 'none';
        prev = 'main';
        sel = { mode: 'vs-cpu', p1: 'solaris', p2: 'gorrath', stage: stages_js_3.STAGES[0].id, aiMode: 'normal', infiniteEnergy: false };
        focus = 'p1';
        resultView = null;
        remapTarget = null;
        resetArmed = false;
        toastTimer = 0;
        onlineText = '';
        onlineCode = '';
        onlineBusy = false;
        constructor(root, save, input, cb) {
            this.root = root;
            this.save = save;
            this.input = input;
            this.cb = cb;
            root.addEventListener('click', (e) => this.onClick(e));
            root.addEventListener('input', (e) => this.onInput(e));
            root.addEventListener('change', (e) => this.onInput(e));
        }
        get screen() {
            return this.current;
        }
        get selection() {
            return this.sel;
        }
        isOpen() {
            return this.current !== 'none';
        }
        toast(msg) {
            const el = document.getElementById('toast');
            if (!el)
                return;
            el.textContent = msg;
            el.classList.add('show');
            window.clearTimeout(this.toastTimer);
            this.toastTimer = window.setTimeout(() => el.classList.remove('show'), 2600);
        }
        hide() {
            this.current = 'none';
            this.root.classList.add('hidden');
            this.root.innerHTML = '';
        }
        show(name, opts = {}) {
            if (name === 'none') {
                this.hide();
                return;
            }
            if (name === 'controls' || name === 'options' || name === 'records') {
                this.prev = this.current === 'pause' ? 'pause' : this.current === 'none' ? 'main' : this.current === 'result' ? 'result' : 'main';
                if (opts.fromPause)
                    this.prev = 'pause';
            }
            this.current = name;
            this.root.classList.remove('hidden');
            this.render();
        }
        showResult(view) {
            this.resultView = view;
            this.show('result');
        }
        startSelect(mode) {
            this.sel.mode = mode;
            this.focus = 'p1';
            this.show('select');
            this.cb.preview(this.sel.p1, this.sel.p2, this.sel.stage);
        }
        startOnline() {
            this.sel.mode = 'online';
            this.focus = 'p1';
            this.onlineText = '';
            this.onlineCode = '';
            this.onlineBusy = false;
            this.show('online');
            this.cb.preview(this.sel.p1, this.sel.p2, this.sel.stage);
        }
        /** Update the lobby status line without re-rendering (so a half-typed room code is never lost). */
        setOnlineStatus(text, code = '', busy = true) {
            this.onlineText = text;
            if (code)
                this.onlineCode = code;
            this.onlineBusy = busy;
            if (this.current !== 'online')
                return;
            const st = this.root.querySelector('#online-status');
            if (st)
                st.textContent = text;
            const cd = this.root.querySelector('#online-code');
            if (cd) {
                cd.textContent = this.onlineCode;
                cd.classList.toggle('hidden', !this.onlineCode);
            }
            this.root.querySelectorAll('[data-online-lock]').forEach((b) => { b.disabled = this.onlineBusy; });
        }
        // ----------------------------------------------------------------- render
        render() {
            switch (this.current) {
                case 'main':
                    this.root.innerHTML = this.mainHtml();
                    break;
                case 'select':
                    this.root.innerHTML = this.selectHtml();
                    break;
                case 'online':
                    this.root.innerHTML = this.onlineHtml();
                    break;
                case 'controls':
                    this.root.innerHTML = this.controlsHtml();
                    break;
                case 'options':
                    this.root.innerHTML = this.optionsHtml();
                    break;
                case 'records':
                    this.root.innerHTML = this.recordsHtml();
                    break;
                case 'pause':
                    this.root.innerHTML = this.pauseHtml();
                    break;
                case 'result':
                    this.root.innerHTML = this.resultHtml();
                    break;
                default: break;
            }
        }
        mainHtml() {
            const r = this.save.records;
            return `
    <section class="screen main">
      <div class="logo"><div class="l1">${(0, strings_js_2.t)('title.main')}</div><div class="l2">${(0, strings_js_2.t)('title.sub')}</div></div>
      <nav class="menu">
        <button class="btn big primary" data-act="mode:vs-cpu">${(0, strings_js_2.t)('menu.vscpu')}</button>
        <button class="btn big" data-act="mode:battle">${(0, strings_js_2.t)('menu.battle')}</button>
        <button class="btn big" data-act="mode:vs-2p">${(0, strings_js_2.t)('menu.vs2p')}</button>
        <button class="btn big" data-act="mode:practice">${(0, strings_js_2.t)('menu.practice')}</button>
        <button class="btn big" data-act="online">ONLINE VS</button>
        <div class="row">
          <button class="btn" data-act="go:controls">${(0, strings_js_2.t)('menu.controls')}</button>
          <button class="btn" data-act="go:options">${(0, strings_js_2.t)('menu.options')}</button>
          <button class="btn" data-act="go:records">${(0, strings_js_2.t)('menu.records')}</button>
        </div>
      </nav>
      <div class="foot">${(0, strings_js_2.t)('menu.footer')}<br><span class="dim">W ${r.wins} / L ${r.losses} &middot; best streak ${r.bestStreak}${this.save.storageOk ? '' : ' &middot; saving unavailable in this browser'}</span></div>
    </section>`;
        }
        card(def, selected, who) {
            const c = def.rig.colors;
            return `<button class="card ${selected ? 'sel' : ''} ${who}" data-act="pick:${who}:${def.id}" style="--c1:${rgb(c.body)};--c2:${rgb(c.accent)};--c3:${rgb(c.glow)}">
      <span class="portrait"><b>${esc(def.name[0])}</b><i>placeholder art</i></span>
      <span class="cname">${esc(def.name)}</span><span class="ccat">${esc(def.category)}</span></button>`;
        }
        statBar(label, v, max) {
            return `<div class="stat"><span>${label}</span><div><i style="width:${Math.min(100, (v / max) * 100)}%"></i></div></div>`;
        }
        detail(def) {
            const s = def.stats;
            const m = def.moves;
            return `<div class="detail" style="--c1:${rgb(def.rig.colors.body)};--c3:${rgb(def.rig.colors.glow)}">
      <h3>${esc(def.name)} <small>${esc(def.title)}</small></h3>
      <div class="tags"><span>${esc(def.category)}</span><span>${esc(def.archetype)}</span></div>
      <p>${esc(def.blurb)}</p>
      ${this.statBar('Power', s.power, 1.5)}${this.statBar('Speed', s.speed, 40)}${this.statBar('Defense', s.defense, 80)}${this.statBar('Health', s.maxHp, 1400)}${this.statBar('Weight', s.mass, 400)}
      <ul class="moves">
        <li><b>Combo</b> ${m.lights.map((a) => esc(a.name)).join(' &rarr; ')}</li>
        <li><b>Heavy</b> ${esc(m.heavy.name)} / ${esc(m.heavyForward.name)}</li>
        <li><b>Special</b> ${esc(m.special.name)}</li>
        <li><b>Grab</b> ${esc(m.grab.name)}</li>
        <li><b>Beam</b> ${esc(m.beam.name)}</li>
        ${def.timer ? `<li><b>Power timer</b> ${def.timer.seconds}s of full strength</li>` : ''}
      </ul></div>`;
        }
        selectHtml() {
            const chars = CharacterRegistry_js_1.registry.list();
            const s = this.sel;
            const mode = s.mode;
            const showP2 = mode !== 'battle';
            const p2Label = mode === 'vs-2p' ? (0, strings_js_2.t)('select.p2') : mode === 'practice' ? (0, strings_js_2.t)('select.dummy') : (0, strings_js_2.t)('select.cpu');
            const planned = CharacterRegistry_js_1.PLANNED_SLOTS.map((p) => `<button class="card locked" data-act="locked:${esc(p.id)}"><span class="portrait"><b>?</b></span><span class="cname">${esc(p.group)}</span><span class="ccat">${(0, strings_js_2.t)('select.locked')}</span></button>`).join('');
            const focusDef = CharacterRegistry_js_1.registry.get(this.focus === 'p1' ? s.p1 : s.p2);
            const stages = stages_js_3.STAGES.map((st) => `<button class="chip ${st.id === s.stage ? 'sel' : ''}" data-act="stage:${st.id}">${esc(st.name)}</button>`).join('');
            const ai = mode === 'practice'
                ? `<div class="chips"><span class="lbl">Dummy</span>${['stationary', 'guard', 'attack', 'dodge'].map((m) => `<button class="chip ${s.aiMode === m ? 'sel' : ''}" data-act="ai:${m}">${m}</button>`).join('')}
         <button class="chip ${s.infiniteEnergy ? 'sel' : ''}" data-act="inf">infinite energy</button></div>`
                : '';
            return `
    <section class="screen select">
      <header><button class="btn small" data-act="back">&larr; ${(0, strings_js_2.t)('select.back')}</button><h2>${MODE_TITLES[mode]}</h2><span></span></header>
      <div class="sel-body">
        <div class="sel-left">
          <div class="rowlabel ${this.focus === 'p1' ? 'active' : ''}" data-act="focus:p1">${(0, strings_js_2.t)('select.p1')}: <b>${esc(CharacterRegistry_js_1.registry.get(s.p1).name)}</b></div>
          <div class="cards">${chars.map((c) => this.card(c, c.id === s.p1, 'p1')).join('')}<button class="card rnd" data-act="random:p1"><span class="portrait"><b>?</b></span><span class="cname">${(0, strings_js_2.t)('select.random')}</span></button></div>
          ${showP2 ? `<div class="rowlabel ${this.focus === 'p2' ? 'active' : ''}" data-act="focus:p2">${p2Label}: <b>${esc(CharacterRegistry_js_1.registry.get(s.p2).name)}</b></div>
          <div class="cards">${chars.map((c) => this.card(c, c.id === s.p2, 'p2')).join('')}<button class="card rnd" data-act="random:p2"><span class="portrait"><b>?</b></span><span class="cname">${(0, strings_js_2.t)('select.random')}</span></button></div>` : '<div class="note">Five opponents of rising difficulty. The roster is small, so opponents repeat on later fights.</div>'}
          <details class="planned"><summary>Roster slots planned for later (${CharacterRegistry_js_1.PLANNED_SLOTS.length}) - not playable</summary><div class="cards">${planned}</div></details>
        </div>
        <div class="sel-right">${this.detail(focusDef)}</div>
      </div>
      <footer>
        <div class="chips"><span class="lbl">${(0, strings_js_2.t)('select.stage')}</span>${stages}</div>
        ${ai}
        <button class="btn big primary" data-act="start">${(0, strings_js_2.t)('select.start')}</button>
      </footer>
    </section>`;
        }
        onlineHtml() {
            const chars = CharacterRegistry_js_1.registry.list();
            const s = this.sel;
            const stages = stages_js_3.STAGES.map((st) => `<button class="chip ${st.id === s.stage ? 'sel' : ''}" data-act="stage:${st.id}" data-online-lock ${this.onlineBusy ? 'disabled' : ''}>${esc(st.name)}</button>`).join('');
            const dis = this.onlineBusy ? 'disabled' : '';
            return `
    <section class="screen select online">
      <header><button class="btn small" data-act="back">&larr; ${(0, strings_js_2.t)('select.back')}</button><h2>ONLINE VS</h2><span></span></header>
      <div class="sel-body">
        <div class="sel-left">
          <div class="rowlabel active">Your fighter: <b>${esc(CharacterRegistry_js_1.registry.get(s.p1).name)}</b></div>
          <div class="cards">${chars.map((c) => this.card(c, c.id === s.p1, 'p1')).join('')}</div>
          <div class="chips"><span class="lbl">Stage (host picks)</span>${stages}</div>
          <p class="dim">Rounds and timer come from the host's Options. Both players need this page open and a steady connection. Press Esc twice during a match to leave.</p>
        </div>
        <div class="sel-right"><div class="detail online-box">
          <h3>Play a friend</h3>
          <button class="btn big primary" data-act="ocreate" data-online-lock ${dis}>Create room</button>
          <div id="online-code" class="room-code ${this.onlineCode ? '' : 'hidden'}">${esc(this.onlineCode)}</div>
          <div class="join-row"><input id="join-code" maxlength="4" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="CODE" ${dis} data-online-lock>
            <button class="btn big" data-act="ojoin" data-online-lock ${dis}>Join room</button></div>
          <div id="online-status" class="note" role="status">${esc(this.onlineText)}</div>
          <button class="btn small" data-act="ocancel">Cancel</button>
        </div></div>
      </div>
    </section>`;
        }
        controlsHtml() {
            const s = this.save.settings;
            const kb = Object.keys(SaveManager_js_1.DEFAULT_KEYS).map((k) => `<tr><td>${ACTION_LABEL[k]}</td><td><kbd>${(0, InputManager_js_1.keyLabel)(s.keys[k])}</kbd></td><td><kbd>${(0, InputManager_js_1.keyLabel)(InputManager_js_1.P2_KEYS[k])}</kbd></td></tr>`).join('');
            const touch = SaveManager_js_1.TOUCH_BUTTONS.map((b) => `<tr><td><kbd>${TOUCH_GLYPH[b]}</kbd></td><td>${ACTION_NAMES[s.touchMap[b]]}</td></tr>`).join('');
            return `
    <section class="screen info">
      <header><button class="btn small" data-act="back">&larr; ${(0, strings_js_2.t)('back')}</button><h2>${(0, strings_js_2.t)('menu.controls')}</h2><span></span></header>
      <div class="info-grid">
        <div><h3>Keyboard</h3><table><tr><th></th><th>Player 1</th><th>Player 2</th></tr>${kb}<tr><td>Pause</td><td><kbd>Esc</kbd> / <kbd>P</kbd></td><td></td></tr></table></div>
        <div><h3>Gamepad</h3><table>
          <tr><td>Move</td><td>Left stick / D-pad</td></tr>
          <tr><td>Light / Heavy</td><td>Square (X) / Circle (B)</td></tr>
          <tr><td>Jump / Special</td><td>Cross (A) / Triangle (Y)</td></tr>
          <tr><td>Guard / Grab</td><td>L1 (LB) / R1 (RB)</td></tr>
          <tr><td>Dodge / Beam</td><td>L2 (LT) / R2 (RT)</td></tr>
          <tr><td>Pause</td><td>Start</td></tr></table>
          <h3>Touch</h3><table>${touch}<tr><td>START</td><td>Pause</td></tr><tr><td>SELECT</td><td>This panel</td></tr></table></div>
        <div class="tips"><h3>How to fight</h3><ul>
          <li><b>Guard</b> blocks frontal hits. Tap guard just before impact for a <b>perfect guard counter</b>. Guard drains and can <b>break</b>.</li>
          <li><b>Dodge</b> with a direction held to sidestep (brief invulnerability), then punish the recovery.</li>
          <li><b>Grab</b> beats guard. If you are grabbed, press grab in time to escape.</li>
          <li><b>Beam</b>: hold to charge, release to fire (costs energy). Longer charge = stronger. Two beams meeting start a <b>beam clash</b>: mash the beam button, higher charge wins.</li>
          <li>Heavy attacks launch and knock down; fast fighters strike quicker but lighter. Heavier giants are pushed back less.</li>
          <li>Forward + Heavy uses the fighter's forward heavy. Light attacks chain into a combo.</li></ul></div>
      </div>
    </section>`;
        }
        slider(opt, label, v, min, max, step, fmt = (x) => x.toFixed(2)) {
            return `<label class="opt"><span>${label}</span><input type="range" data-opt="${opt}" min="${min}" max="${max}" step="${step}" value="${v}"><output>${fmt(v)}</output></label>`;
        }
        select(opt, label, v, options) {
            return `<label class="opt"><span>${label}</span><select data-opt="${opt}">${options.map(([val, txt]) => `<option value="${val}" ${String(val) === String(v) ? 'selected' : ''}>${txt}</option>`).join('')}</select></label>`;
        }
        check(opt, label, v) {
            return `<label class="opt"><span>${label}</span><input type="checkbox" data-opt="${opt}" ${v ? 'checked' : ''}></label>`;
        }
        optionsHtml() {
            const s = this.save.settings;
            const keys = Object.keys(SaveManager_js_1.DEFAULT_KEYS).map((k) => {
                const waiting = this.remapTarget === `key:${k}`;
                return `<button class="remap ${waiting ? 'wait' : ''}" data-act="remap:key:${k}"><span>${ACTION_LABEL[k]}</span><kbd>${waiting ? 'press a key...' : (0, InputManager_js_1.keyLabel)(s.keys[k])}</kbd></button>`;
            }).join('');
            const touch = SaveManager_js_1.TOUCH_BUTTONS.map((b) => `<label class="remap"><span>${TOUCH_GLYPH[b]}</span><select data-opt="tmap:${b}">${SaveManager_js_1.BINDABLE.map((a) => `<option value="${a}" ${s.touchMap[b] === a ? 'selected' : ''}>${ACTION_NAMES[a]}</option>`).join('')}</select></label>`).join('');
            return `
    <section class="screen info options">
      <header><button class="btn small" data-act="back">&larr; ${(0, strings_js_2.t)('back')}</button><h2>${(0, strings_js_2.t)('options.title')}</h2><span></span></header>
      <div class="info-grid">
        <div><h3>Audio</h3>
          ${this.slider('master', 'Master volume', s.master, 0, 1, 0.05)}
          ${this.slider('music', 'Music volume', s.music, 0, 1, 0.05)}
          ${this.slider('sfx', 'Effects volume', s.sfx, 0, 1, 0.05)}
          <h3>Game</h3>
          ${this.select('difficulty', 'CPU difficulty', s.difficulty, [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']])}
          ${this.select('rounds', 'Rounds (best of)', s.rounds, [[1, '1'], [3, '3'], [5, '5']])}
          ${this.select('matchTime', 'Round timer', s.matchTime, [[0, 'Off'], [60, '60s'], [99, '99s']])}
          <h3>Display</h3>
          ${this.select('quality', 'Graphics quality', s.quality, [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])}
          ${this.check('shake', 'Camera shake', s.shake)}
          <button class="btn small" data-act="fullscreen">Toggle fullscreen</button>
          <h3>Save data</h3>
          <button class="btn small danger" data-act="reset-save">${this.resetArmed ? 'Click again to CONFIRM reset' : 'Reset all saved data'}</button>
        </div>
        <div><h3>Keyboard (Player 1)</h3><div class="remaps">${keys}</div>
          <button class="btn small" data-act="reset-keys">Restore default keys</button>
          <p class="dim">Player 2 keys are fixed (see Controls). Press Esc while remapping to cancel.</p></div>
        <div><h3>Touch controller</h3>
          ${this.select('touch', 'On-screen controller', s.touch, [['auto', 'Auto (touch devices)'], ['on', 'Always on'], ['off', 'Off']])}
          ${this.slider('touchOpacity', 'Opacity', s.touchOpacity, 0.2, 1, 0.05)}
          ${this.slider('touchScale', 'Size', s.touchScale, 0.7, 1.5, 0.05)}
          ${this.slider('stickDeadzone', 'Stick dead zone', s.stickDeadzone, 0, 0.6, 0.02)}
          ${this.slider('stickSensitivity', 'Stick sensitivity', s.stickSensitivity, 0.5, 2, 0.05)}
          ${this.check('leftHanded', 'Left-handed layout', s.leftHanded)}
          <h3>Button mapping</h3><div class="remaps">${touch}</div>
          <button class="btn small" data-act="reset-touch">Restore default mapping</button></div>
      </div>
    </section>`;
        }
        recordsHtml() {
            const r = this.save.records;
            const rows = r.history.map((h) => `<tr><td>${new Date(h.at).toLocaleDateString()}</td><td>${esc(h.mode)}</td><td>${esc(h.p1)} vs ${esc(h.p2)}</td><td>${esc(h.stage)}</td><td class="${h.winner}">${h.winner === 'p1' ? 'P1' : h.winner === 'p2' ? 'P2' : 'Draw'}</td><td>${esc(h.rounds)}</td><td>${h.rank ?? ''}</td></tr>`).join('');
            return `
    <section class="screen info">
      <header><button class="btn small" data-act="back">&larr; ${(0, strings_js_2.t)('back')}</button><h2>${(0, strings_js_2.t)('menu.records')}</h2><span></span></header>
      <div class="stats-row"><div><b>${r.wins}</b>wins</div><div><b>${r.losses}</b>losses</div><div><b>${r.streak}</b>streak</div><div><b>${r.bestStreak}</b>best streak</div><div><b>${r.battleBest}/5</b>battle mode best</div></div>
      <p class="dim">Battle history only: this is a results log, not a replay system.</p>
      <table class="hist"><tr><th>Date</th><th>Mode</th><th>Fighters</th><th>Stage</th><th>Winner</th><th>Rounds</th><th>Rank</th></tr>${rows || '<tr><td colspan="7" class="dim">No matches recorded yet.</td></tr>'}</table>
    </section>`;
        }
        pauseHtml() {
            const practice = this.sel.mode === 'practice';
            return `
    <section class="screen pause"><div class="panel">
      <h2>${(0, strings_js_2.t)('pause.title')}</h2>
      <button class="btn big primary" data-act="resume">${(0, strings_js_2.t)('pause.resume')}</button>
      ${practice ? `<button class="btn big" data-act="resetpos">${(0, strings_js_2.t)('pause.reset')}</button>` : ''}
      <button class="btn big" data-act="restart">${(0, strings_js_2.t)('pause.restart')}</button>
      <div class="row"><button class="btn" data-act="go:controls">${(0, strings_js_2.t)('menu.controls')}</button><button class="btn" data-act="go:options">${(0, strings_js_2.t)('menu.options')}</button></div>
      <button class="btn big" data-act="quit">${(0, strings_js_2.t)('pause.quit')}</button>
    </div></section>`;
        }
        resultHtml() {
            const v = this.resultView;
            if (!v)
                return '';
            return `
    <section class="screen result ${v.outcome}"><div class="panel">
      <h1>${esc(v.heading)}</h1><div class="sub">${esc(v.sub)}</div>
      <ul class="lines">${v.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
      <div class="btns">${v.buttons.map((b) => `<button class="btn big ${b.primary ? 'primary' : ''}" data-act="result:${b.act}">${esc(b.label)}</button>`).join('')}</div>
    </div></section>`;
        }
        // ----------------------------------------------------------------- events
        onClick(e) {
            const el = e.target.closest('[data-act]');
            if (!el)
                return;
            const act = el.dataset.act ?? '';
            const [verb, a, b] = act.split(':');
            const s = this.sel;
            switch (verb) {
                case 'mode':
                    this.cb.sound('ui');
                    this.startSelect(a);
                    return;
                case 'go':
                    this.cb.sound('ui');
                    this.show(a);
                    return;
                case 'back':
                    this.cb.sound('uiBack');
                    this.cancelRemap();
                    if (this.current === 'online')
                        this.cb.onlineCancel();
                    this.show(this.current === 'select' || this.current === 'online' ? 'main' : this.prev);
                    return;
                case 'online':
                    this.cb.sound('ui');
                    this.startOnline();
                    return;
                case 'ocreate':
                    this.cb.sound('ui');
                    this.setOnlineStatus('Connecting...', '', true);
                    this.cb.onlineCreate({ ...s });
                    return;
                case 'ojoin': {
                    const code = (this.root.querySelector('#join-code')?.value ?? '').trim().toUpperCase();
                    if (code.length !== 4) {
                        this.setOnlineStatus('Type the 4-letter code your friend shows.', '', false);
                        return;
                    }
                    this.cb.sound('ui');
                    this.setOnlineStatus('Connecting...', '', true);
                    this.cb.onlineJoin({ ...s }, code);
                    return;
                }
                case 'ocancel':
                    this.cb.sound('uiBack');
                    this.cb.onlineCancel();
                    this.onlineCode = '';
                    this.setOnlineStatus('', '', false);
                    this.onlineCode = '';
                    this.render();
                    return;
                case 'pick':
                    if (this.current === 'online' && this.onlineBusy)
                        return;
                    this.cb.sound('ui');
                    if (a === 'p1') {
                        s.p1 = b;
                        this.focus = 'p1';
                    }
                    else {
                        s.p2 = b;
                        this.focus = 'p2';
                    }
                    this.render();
                    this.cb.preview(s.p1, s.p2, s.stage);
                    return;
                case 'focus':
                    this.focus = a;
                    this.render();
                    return;
                case 'random': {
                    const ids = CharacterRegistry_js_1.registry.list().map((c) => c.id);
                    const pick = ids[Math.floor(Math.random() * ids.length)];
                    if (a === 'p1')
                        s.p1 = pick;
                    else
                        s.p2 = pick;
                    this.focus = a;
                    this.cb.sound('ui');
                    this.render();
                    this.cb.preview(s.p1, s.p2, s.stage);
                    return;
                }
                case 'locked':
                    this.toast('Planned roster slot: no model, moves or animation exist for it yet.');
                    return;
                case 'stage':
                    s.stage = a;
                    this.cb.sound('ui');
                    this.render();
                    this.cb.preview(s.p1, s.p2, s.stage);
                    return;
                case 'ai':
                    s.aiMode = a;
                    this.render();
                    return;
                case 'inf':
                    s.infiniteEnergy = !s.infiniteEnergy;
                    this.render();
                    return;
                case 'start':
                    this.cb.sound('ui');
                    this.cb.start({ ...s });
                    return;
                case 'resume':
                    this.cb.resume();
                    return;
                case 'restart':
                    this.cb.restart();
                    return;
                case 'resetpos':
                    this.cb.resetPositions();
                    return;
                case 'quit':
                    this.cb.quit();
                    return;
                case 'result':
                    this.cb.resultAction(a);
                    return;
                case 'fullscreen':
                    this.toggleFullscreen();
                    return;
                case 'remap':
                    this.beginRemap(`${a}:${b}`);
                    return;
                case 'reset-keys':
                    this.save.settings.keys = { ...SaveManager_js_1.DEFAULT_KEYS };
                    this.commit();
                    return;
                case 'reset-touch':
                    this.save.settings.touchMap = { ...SaveManager_js_1.DEFAULT_TOUCH_MAP };
                    this.commit();
                    return;
                case 'reset-save':
                    if (!this.resetArmed) {
                        this.resetArmed = true;
                        this.render();
                        window.setTimeout(() => { this.resetArmed = false; if (this.current === 'options')
                            this.render(); }, 4000);
                    }
                    else {
                        this.resetArmed = false;
                        this.cb.resetSave();
                        this.render();
                        this.toast('Saved data reset.');
                    }
                    return;
                default: return;
            }
        }
        commit() {
            this.save.save();
            this.cb.settingsChanged();
            this.render();
        }
        toggleFullscreen() {
            try {
                if (document.fullscreenElement)
                    void document.exitFullscreen();
                else
                    void document.documentElement.requestFullscreen();
            }
            catch {
                this.toast('Fullscreen is not available in this browser.');
            }
        }
        cancelRemap() {
            if (this.remapTarget) {
                this.input.cancelCapture();
                this.remapTarget = null;
            }
        }
        beginRemap(target) {
            this.cancelRemap();
            this.remapTarget = target;
            this.render();
            this.input.captureNextKey((code) => {
                const t0 = this.remapTarget;
                this.remapTarget = null;
                if (t0 && code) {
                    const key = t0.slice(4);
                    const keys = this.save.settings.keys;
                    // Swap on conflict so two actions never share a key.
                    const clash = Object.keys(keys).find((k) => keys[k] === code && k !== key);
                    if (clash)
                        keys[clash] = keys[key];
                    keys[key] = code;
                    this.save.save();
                    this.cb.settingsChanged();
                }
                if (this.current === 'options')
                    this.render();
            });
        }
        onInput(e) {
            const el = e.target;
            const opt = el.dataset?.opt;
            if (!opt)
                return;
            const s = this.save.settings;
            if (opt.startsWith('tmap:')) {
                this.save.settings.touchMap[opt.slice(5)] = el.value;
            }
            else if (el instanceof HTMLInputElement && el.type === 'checkbox') {
                s[opt] = el.checked;
            }
            else if (el instanceof HTMLInputElement && el.type === 'range') {
                s[opt] = Number(el.value);
                const out = el.nextElementSibling;
                if (out)
                    out.textContent = Number(el.value).toFixed(2);
            }
            else if (opt === 'rounds' || opt === 'matchTime') {
                s[opt] = Number(el.value);
            }
            else {
                s[opt] = el.value;
            }
            // Re-validate through the same sanitiser used on load.
            this.save.data.settings = (0, SaveManager_js_1.sanitizeSettings)(this.save.settings);
            this.save.save();
            this.cb.settingsChanged();
            if (e.type === 'change' && el instanceof HTMLSelectElement)
                this.render();
        }
    }
    exports.Screens = Screens;
});
define("net/Lockstep", ["require", "exports", "combat/types"], function (require, exports, types_js_4) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Lockstep = void 0;
    exports.packInput = packInput;
    exports.unpackInput = unpackInput;
    exports.parsePacked = parsePacked;
    exports.hashBattle = hashBattle;
    const AXIS = 127;
    const ALL_BITS = (1 << types_js_4.ACTIONS.length) - 1;
    const bits = (set) => {
        let n = 0;
        types_js_4.ACTIONS.forEach((a, i) => { if (set[a])
            n |= 1 << i; });
        return n;
    };
    const fromBits = (n) => {
        const s = (0, types_js_4.emptyActions)();
        types_js_4.ACTIONS.forEach((a, i) => { s[a] = (n & (1 << i)) !== 0; });
        return s;
    };
    /** Quantise + pack. The SAME quantised frame is used locally, so both machines simulate identical numbers. */
    function packInput(f) {
        const q = (v) => Math.max(-AXIS, Math.min(AXIS, Math.round((Number.isFinite(v) ? v : 0) * AXIS)));
        return [q(f.moveX), q(f.moveY), bits(f.held), bits(f.pressed)];
    }
    function unpackInput(p) {
        return { moveX: p[0] / AXIS, moveY: p[1] / AXIS, held: fromBits(p[2]), pressed: fromBits(p[3]) };
    }
    /** Validate untrusted network data. Returns null if it is not a well-formed packed input. */
    function parsePacked(x) {
        if (!Array.isArray(x) || x.length !== 4)
            return null;
        const [mx, my, h, p] = x;
        const okAxis = (v) => Number.isInteger(v) && Math.abs(v) <= AXIS;
        const okBits = (v) => Number.isInteger(v) && v >= 0 && v <= ALL_BITS;
        if (!okAxis(mx) || !okAxis(my) || !okBits(h) || !okBits(p))
            return null;
        return [mx, my, h, p];
    }
    /** Reject packets claiming to be absurdly far in the future (memory bound against a misbehaving peer). */
    const MAX_AHEAD = 240;
    class Lockstep {
        localIndex;
        delay;
        /** Next simulation tick to run. */
        simTick = 0;
        /** Next tick a local input will be captured for. */
        localTick;
        local = new Map();
        remote = new Map();
        constructor(localIndex, delay) {
            this.localIndex = localIndex;
            this.delay = delay;
            this.localTick = delay;
            for (let t = 0; t < delay; t++) {
                this.local.set(t, (0, types_js_4.emptyInput)());
                this.remote.set(t, (0, types_js_4.emptyInput)());
            }
        }
        /** True when a fresh local input should be sampled (exactly one per simulation tick, `delay` ticks ahead). */
        canCapture() {
            return this.localTick <= this.simTick + this.delay;
        }
        /** Record this machine's input for its next tick. Returns the message to send: [tick, packed input]. */
        capture(frame) {
            const packed = packInput(frame);
            const t = this.localTick++;
            this.local.set(t, unpackInput(packed));
            return [t, packed];
        }
        /** Store the opponent's input for tick `t`. Returns false if it was rejected (stale, too far ahead, malformed). */
        receive(t, packed) {
            const p = parsePacked(packed);
            if (!p || typeof t !== 'number' || !Number.isInteger(t) || t < this.simTick || t > this.simTick + MAX_AHEAD)
                return false;
            if (!this.remote.has(t))
                this.remote.set(t, unpackInput(p));
            return true;
        }
        canStep() {
            return this.local.has(this.simTick) && this.remote.has(this.simTick);
        }
        /** Consume tick `simTick`; returns the two inputs in player order [player 1, player 2]. */
        step() {
            const t = this.simTick;
            const mine = this.local.get(t);
            const theirs = this.remote.get(t);
            this.local.delete(t);
            this.remote.delete(t);
            this.simTick++;
            return this.localIndex === 0 ? [mine, theirs] : [theirs, mine];
        }
    }
    exports.Lockstep = Lockstep;
    /** Fingerprint of everything that must match between the two machines (used to detect a desync). */
    function hashBattle(b) {
        let h = 0x811c9dc5;
        const mix = (n) => {
            const v = Math.round(n * 256) | 0;
            h = Math.imul(h ^ (v & 0xffff), 0x01000193);
            h = Math.imul(h ^ ((v >> 16) & 0xffff), 0x01000193);
        };
        for (const f of b.fighters) {
            mix(f.x);
            mix(f.y);
            mix(f.z);
            mix(f.yaw);
            mix(f.hp);
            mix(f.energy);
            mix(f.guard);
            for (let i = 0; i < f.state.length; i++)
                h = Math.imul(h ^ f.state.charCodeAt(i), 0x01000193);
        }
        return h >>> 0;
    }
});
define("net/OnlineSession", ["require", "exports", "characters/CharacterRegistry", "data/stages", "net/Lockstep"], function (require, exports, CharacterRegistry_js_2, stages_js_4, Lockstep_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.OnlineSession = void 0;
    const ERRORS = {
        'no-room': 'No room with that code. Check the letters and ask your friend to keep the room open.',
        full: 'That room already has two players.',
        busy: 'The server is busy. Try again in a moment.',
    };
    /** Hash exchange interval (ticks) and how many past hashes are kept. */
    const HASH_EVERY = 30;
    /**
     * One online match connection: connects to the room server, pairs two players with a room code, agrees the match
     * settings, then forwards per-tick inputs to the `Lockstep`. Contains no rendering; the Game drives it.
     */
    class OnlineSession {
        url;
        myChar;
        host;
        h;
        role = 0;
        lock = null;
        code = '';
        /** Smoothed round-trip time in ms (updated during the match from input arrival spacing is NOT used; lobby ping only). */
        rttMs = 0;
        ws = null;
        closedNotified = false;
        peerChar = '';
        myRematch = false;
        peerRematch = false;
        pings = [];
        pingSent = new Map();
        lastCfg = null;
        localHash = new Map();
        remoteHash = new Map();
        desynced = false;
        /** Wall-clock time (ms) of the last message from the peer; used to detect a vanished opponent. */
        lastHeard = 0;
        constructor(url, myChar, host, h) {
            this.url = url;
            this.myChar = myChar;
            this.host = host;
            this.h = h;
        }
        // ------------------------------------------------------------- connect
        create() {
            this.role = 0;
            this.open(() => this.raw({ t: 'create' }), 'Connecting to the server...');
        }
        join(code) {
            this.role = 1;
            this.open(() => this.raw({ t: 'join', code }), 'Connecting to the server...');
        }
        open(onOpen, text) {
            this.h.status(text);
            let ws;
            try {
                ws = new WebSocket(this.url);
            }
            catch {
                this.finish('Could not open a connection. Check the server address.');
                return;
            }
            this.ws = ws;
            ws.onopen = onOpen;
            ws.onmessage = (e) => this.onRaw(typeof e.data === 'string' ? e.data : '');
            ws.onerror = () => { };
            ws.onclose = () => this.finish(this.lock ? 'The connection to your opponent was lost.' : 'Could not reach the online server. Is it running, and is the address right?');
        }
        raw(obj) {
            if (this.ws?.readyState === WebSocket.OPEN)
                this.ws.send(JSON.stringify(obj));
        }
        send(w) {
            this.raw({ t: 'msg', d: w });
        }
        finish(reason) {
            if (this.closedNotified)
                return;
            this.closedNotified = true;
            this.h.closed(reason);
        }
        /** Leave: closes the socket (the other player is told). No further callbacks fire. */
        close() {
            this.closedNotified = true;
            const ws = this.ws;
            this.ws = null;
            if (ws) {
                ws.onclose = null;
                ws.onmessage = null;
                try {
                    ws.close();
                }
                catch { /* already closed */ }
            }
            this.lock = null;
        }
        get connected() {
            return this.ws?.readyState === WebSocket.OPEN;
        }
        // ------------------------------------------------------------ messages
        onRaw(text) {
            let m;
            try {
                m = JSON.parse(text);
            }
            catch {
                return;
            }
            if (!m || typeof m !== 'object')
                return;
            switch (m.t) {
                case 'created':
                    if (typeof m.code === 'string') {
                        this.code = m.code;
                        this.h.status('Waiting for a friend to join...', m.code);
                    }
                    break;
                case 'peer': // host: a guest arrived
                    this.h.status('Friend joined. Waiting for their fighter...', this.code);
                    break;
                case 'joined': // guest: in the room; tell the host which fighter we picked
                    this.h.status('Joined. Waiting for the host to start...');
                    this.send({ k: 'pick', c: this.myChar });
                    break;
                case 'left':
                    this.finish(this.lock ? 'Your opponent left the match.' : 'Your opponent left.');
                    break;
                case 'error':
                    this.finish(ERRORS[m.reason ?? ''] ?? 'The server refused the request.');
                    break;
                case 'msg':
                    this.lastHeard = Date.now();
                    this.onWire(m.d);
                    break;
                default:
                    break;
            }
        }
        onWire(d) {
            if (!d || typeof d !== 'object')
                return;
            const w = d;
            switch (w.k) {
                case 'pick':
                    if (this.role === 0 && typeof w.c === 'string' && CharacterRegistry_js_2.registry.list().some((c) => c.id === w.c)) {
                        this.peerChar = w.c;
                        this.h.status('Checking connection speed...', this.code);
                        this.measure();
                    }
                    break;
                case 'ping':
                    if (typeof w.n === 'number')
                        this.send({ k: 'pong', n: w.n });
                    break;
                case 'pong':
                    if (typeof w.n === 'number') {
                        const at = this.pingSent.get(w.n);
                        if (at !== undefined) {
                            this.pings.push(Date.now() - at);
                            this.pingSent.delete(w.n);
                        }
                    }
                    break;
                case 'start':
                    if (this.role === 1)
                        this.onStart(w.cfg);
                    break;
                case 'in':
                    this.lock?.receive(w.t, w.i);
                    break;
                case 'h':
                    if (typeof w.t === 'number' && typeof w.v === 'number')
                        this.onRemoteHash(w.t, w.v);
                    break;
                case 'rematch':
                    this.peerRematch = true;
                    this.maybeRematch();
                    break;
                default:
                    break;
            }
        }
        // ------------------------------------------------------------- start-up
        /** Host: a few pings, then pick an input delay that covers the measured latency. */
        measure() {
            this.pings = [];
            for (let i = 0; i < 5; i++) {
                setTimeout(() => {
                    this.pingSent.set(i, Date.now());
                    this.send({ k: 'ping', n: i });
                }, i * 80);
            }
            setTimeout(() => this.beginAsHost(false), 5 * 80 + 500);
        }
        beginAsHost(rematch) {
            if (this.closedNotified || (!this.peerChar))
                return;
            if (!rematch) {
                const sorted = [...this.pings].sort((a, b) => a - b);
                this.rttMs = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 120;
            }
            // One-way time in ticks plus a little slack, kept inside a playable range.
            const delay = Math.max(3, Math.min(12, Math.ceil(this.rttMs / 2 / (1000 / 60)) + 2));
            const cfg = {
                p1: this.myChar, p2: this.peerChar, stage: this.host.stage, rounds: this.host.rounds, time: this.host.time,
                seed: ((Math.random() * 0x7fffffff) | 0) || 1, delay,
            };
            this.send({ k: 'start', cfg });
            this.begin(cfg);
        }
        /** Guest: validate everything the host sent (it is untrusted input) before using it. */
        onStart(raw) {
            const c = raw;
            const known = (id) => typeof id === 'string' && CharacterRegistry_js_2.registry.list().some((x) => x.id === id);
            if (!c || !known(c.p1) || !known(c.p2) || c.p2 !== this.myChar
                || typeof c.stage !== 'string' || !stages_js_4.STAGES.some((s) => s.id === c.stage)
                || ![1, 3, 5].includes(c.rounds) || ![0, 60, 99].includes(c.time)
                || !Number.isInteger(c.seed) || !Number.isInteger(c.delay) || c.delay < 2 || c.delay > 15) {
                this.finish('The host sent invalid match settings.');
                this.close();
                return;
            }
            this.begin(c);
        }
        begin(cfg) {
            this.lastCfg = cfg;
            this.myRematch = false;
            this.peerRematch = false;
            this.localHash.clear();
            this.remoteHash.clear();
            this.desynced = false;
            this.lock = new Lockstep_js_1.Lockstep(this.role, cfg.delay);
            this.lastHeard = Date.now();
            this.h.start(cfg, this.role, this.lock);
        }
        // ----------------------------------------------------------- in a match
        sendInput(msg) {
            this.send({ k: 'in', t: msg[0], i: msg[1] });
        }
        /** Call after every simulation tick with the number of the tick just completed and a state fingerprint (cheap). */
        reportState(tick, hash) {
            if (tick % HASH_EVERY !== 0 || this.desynced)
                return;
            const v = hash();
            this.localHash.set(tick, v);
            this.send({ k: 'h', t: tick, v });
            this.compare(tick);
        }
        onRemoteHash(t, v) {
            if (this.remoteHash.size > 200)
                return;
            this.remoteHash.set(t, v);
            this.compare(t);
        }
        compare(t) {
            const a = this.localHash.get(t);
            const b = this.remoteHash.get(t);
            if (a === undefined || b === undefined)
                return;
            this.localHash.delete(t);
            this.remoteHash.delete(t);
            if (a !== b && !this.desynced) {
                this.desynced = true;
                this.h.desync(t);
            }
        }
        /** Both players must ask for a rematch; the host then restarts with a fresh seed. */
        requestRematch() {
            this.myRematch = true;
            this.send({ k: 'rematch' });
            this.maybeRematch();
        }
        maybeRematch() {
            if (this.myRematch && this.peerRematch && this.role === 0 && this.lastCfg)
                this.beginAsHost(true);
            else if (this.myRematch && !this.peerRematch)
                this.h.status('Rematch requested. Waiting for your opponent...');
        }
        get rematchWaiting() {
            return this.myRematch && !this.peerRematch;
        }
    }
    exports.OnlineSession = OnlineSession;
});
define("app/TimeScale", ["require", "exports", "math"], function (require, exports, math_js_12) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.TimeScale = exports.MAX_SLOWMO_SECONDS = exports.MIN_SCALE = void 0;
    /** Slowest allowed presentation speed. */
    exports.MIN_SCALE = 0.25;
    /** No single slow-motion request may last longer than this many seconds, whatever the caller asks for. */
    exports.MAX_SLOWMO_SECONDS = 1.5;
    /**
     * Presentation-only slow motion (ultimate release, transformation burst, perfect dodge, KO). It scales how fast
     * real time feeds the fixed-step simulation, so combat stays deterministic. Every request is time-limited and
     * `update()` always returns to exactly 1, so the game can never be left slowed down.
     */
    class TimeScale {
        /** Current speed multiplier (1 = normal). */
        value = 1;
        target = 1;
        remaining = 0;
        /** Slow to `scale` for `seconds` (real time). Overlapping requests keep the slower scale and longer time. */
        request(scale, seconds) {
            const s = (0, math_js_12.clamp)(scale, exports.MIN_SCALE, 1);
            if (s >= 1 || seconds <= 0)
                return;
            const dur = Math.min(seconds, exports.MAX_SLOWMO_SECONDS);
            this.target = this.remaining > 0 ? Math.min(this.target, s) : s;
            this.remaining = Math.max(this.remaining, dur);
        }
        /** Advance by `realDt` seconds and return the scale to apply to this frame. */
        update(realDt) {
            if (this.remaining > 0) {
                this.remaining -= realDt;
                if (this.remaining <= 0) {
                    this.remaining = 0;
                    this.target = 1;
                }
            }
            // Ease toward the target (fast in, softer out) and snap exactly to 1 when close.
            const rate = this.target < this.value ? 18 : 9;
            this.value += (this.target - this.value) * (1 - Math.exp(-rate * realDt));
            if (this.target === 1 && this.value > 0.985)
                this.value = 1;
            this.value = (0, math_js_12.clamp)(this.value, exports.MIN_SCALE, 1);
            return this.value;
        }
        get active() {
            return this.remaining > 0 || this.value < 1;
        }
        /** Immediately return to normal speed (pause, menu, restart, tab switch). */
        reset() {
            this.value = 1;
            this.target = 1;
            this.remaining = 0;
        }
    }
    exports.TimeScale = TimeScale;
});
define("app/Game", ["require", "exports", "ai/CharacterAI", "audio/AudioManager", "characters/CharacterRegistry", "characters/TransformationSystem", "combat/Battle", "combat/types", "data/stages", "input/InputManager", "render/Camera", "render/FighterModel", "render/Renderer", "render/StageRenderer", "render/VFX", "ui/BattleHUD", "ui/Screens", "ui/strings", "net/Lockstep", "net/OnlineSession", "app/Match", "app/SaveManager", "app/TimeScale"], function (require, exports, CharacterAI_js_1, AudioManager_js_1, CharacterRegistry_js_3, TransformationSystem_js_5, Battle_js_2, types_js_5, stages_js_5, InputManager_js_2, Camera_js_1, FighterModel_js_1, Renderer_js_4, StageRenderer_js_1, VFX_js_1, BattleHUD_js_1, Screens_js_1, strings_js_3, Lockstep_js_2, OnlineSession_js_1, Match_js_1, SaveManager_js_2, TimeScale_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.Game = exports.STEP = void 0;
    exports.STEP = 1 / 60;
    const MAX_STEPS = 5;
    const LADDER_DIFFICULTY = ['easy', 'easy', 'normal', 'normal', 'hard'];
    /** Owns the loop and wires simulation -> presentation (VFX, audio, camera, HUD, menus). */
    class Game {
        canvas;
        renderer;
        stageRenderer;
        camera = new Camera_js_1.FightCamera();
        /** Presentation-only slow motion; always time-limited and reset on every state change. */
        timeScale = new TimeScale_js_1.TimeScale();
        vfx = new VFX_js_1.VFX();
        audio = new AudioManager_js_1.AudioManager();
        save = new SaveManager_js_2.SaveManager();
        input;
        hud;
        screens;
        state = 'menu';
        match = null;
        preview = null;
        ai = null;
        animators = [new FighterModel_js_1.FighterAnimator(), new FighterModel_js_1.FighterAnimator()];
        ladder = null;
        lastSel = null;
        acc = 0;
        /** Simulation-speed delta of the current frame (real dt x time scale). */
        simDt = 0;
        lastTime = 0;
        time = 0;
        quality = 'high';
        frameEma = 16;
        slowFrames = 0;
        resultShown = false;
        /** Set while an online room or match exists. */
        online = null;
        onlineLock = null;
        escArmedAt = 0;
        stallSince = 0;
        netBadge = document.getElementById('net-status');
        raf = 0;
        /** Diagnostics for tests / the README. */
        stats = { steps: 0, frames: 0 };
        constructor(canvas, hudRoot, screensRoot, touchRoot) {
            this.canvas = canvas;
            this.renderer = new Renderer_js_4.Renderer(canvas);
            this.stageRenderer = new StageRenderer_js_1.StageRenderer(this.renderer);
            this.input = new InputManager_js_2.InputManager(() => this.save.settings, touchRoot);
            this.hud = new BattleHUD_js_1.BattleHUD(hudRoot);
            this.screens = new Screens_js_1.Screens(screensRoot, this.save, this.input, {
                start: (sel) => this.startMatch(sel),
                preview: (a, b, s) => this.setPreview(a, b, s),
                resume: () => this.resume(),
                restart: () => this.restart(),
                resetPositions: () => { this.match?.resetPositions(); this.resume(); },
                quit: () => this.toMenu(),
                resultAction: (a) => this.resultAction(a),
                settingsChanged: () => this.applySettings(),
                resetSave: () => { this.save.reset(); this.applySettings(); },
                sound: (k) => { this.audio.unlock(); this.audio.play(k); },
                onlineCreate: (sel) => this.beginOnline(sel, null),
                onlineJoin: (sel, code) => this.beginOnline(sel, code),
                onlineCancel: () => this.endOnline(),
            });
            this.input.onPause = () => this.togglePause();
            this.input.onPadDisconnected = () => {
                if (this.state === 'battle')
                    this.pause();
                this.screens.toast('Controller disconnected. Keyboard and touch still work.');
            };
            this.input.onPadConnected = () => this.screens.toast('Controller connected.');
            this.renderer.onContextRestored = () => this.screens.toast('Graphics context restored.');
            window.addEventListener('resize', this.onResize);
            window.addEventListener('orientationchange', () => window.setTimeout(this.onResize, 200));
            window.visualViewport?.addEventListener('resize', this.onResize);
            document.addEventListener('visibilitychange', this.onVisibility);
            document.addEventListener('ufe-select-panel', () => {
                if (this.state === 'battle')
                    this.pause();
                this.screens.show('controls', { fromPause: true });
            });
            // Browsers only allow audio after a gesture.
            const unlock = () => this.audio.unlock();
            window.addEventListener('pointerdown', unlock, { passive: true });
            window.addEventListener('keydown', unlock);
            if (this.save.recovered)
                this.screens.toast('Saved data was unreadable and has been reset.');
            this.applySettings();
            this.setPreview('solaris', 'gorrath', stages_js_5.STAGES[0].id);
            this.screens.show('main');
        }
        // ------------------------------------------------------------- settings
        autoQuality() {
            const mobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
            const mem = navigator.deviceMemory;
            if (mobile)
                return mem !== undefined && mem <= 2 ? 'low' : 'medium';
            return 'high';
        }
        applySettings() {
            const s = this.save.settings;
            this.audio.setVolumes(s.master, s.music, s.sfx);
            this.camera.shakeScale = s.shake ? 1 : 0;
            const q = s.quality === 'auto' ? (this.slowQuality ?? this.autoQuality()) : s.quality;
            this.setQuality(q);
            this.input.touch.applySettings(this.state !== 'menu');
            this.updateBodyClasses();
        }
        /** Set by the adaptive-quality governor; only used while the setting is "auto". */
        slowQuality = null;
        setQuality(q) {
            if (q === this.quality && this.renderer.quality === q)
                return;
            this.quality = q;
            this.renderer.setQuality(q);
            this.vfx.setQuality(q);
            const stage = this.match?.cfg.stage ?? this.preview?.stage;
            if (stage)
                this.stageRenderer.setStage(stage, q);
        }
        updateBodyClasses() {
            const b = document.body.classList;
            b.toggle('in-battle', this.state !== 'menu');
            b.toggle('touch-ui', this.input.touch.visible);
        }
        onResize = () => {
            this.renderer.resize();
            if (this.state === 'battle' && this.input.touch.visible && window.innerHeight > window.innerWidth) {
                this.pause();
            }
        };
        onVisibility = () => {
            if (document.hidden) {
                this.timeScale.reset();
                if (this.state === 'battle')
                    this.pause();
                this.audio.suspend();
                this.audio.beamLoop(0);
            }
            else {
                this.audio.resume();
                this.lastTime = performance.now();
            }
        };
        // ------------------------------------------------------------- previews
        setPreview(a, b, stageId) {
            const stage = (0, stages_js_5.getStage)(stageId);
            this.preview = new Battle_js_2.Battle([CharacterRegistry_js_3.registry.get(a), CharacterRegistry_js_3.registry.get(b)], stage);
            this.preview.controlsEnabled = false;
            this.stageRenderer.setStage(stage, this.quality);
            this.animators = [new FighterModel_js_1.FighterAnimator(), new FighterModel_js_1.FighterAnimator()];
            this.camera.setMode('orbit');
        }
        // ---------------------------------------------------------------- match
        startMatch(sel) {
            this.audio.unlock();
            this.lastSel = { ...sel };
            const s = this.save.settings;
            let p2 = sel.p2;
            let difficulty = s.difficulty;
            let stageId = sel.stage;
            if (sel.mode === 'battle') {
                if (!this.ladder || this.ladder.opponents.length === 0 || this.ladderOwner !== sel.p1)
                    this.makeLadder(sel.p1);
                const l = this.ladder;
                p2 = l.opponents[l.index];
                difficulty = LADDER_DIFFICULTY[l.index];
                stageId = stages_js_5.STAGES[(l.index + stages_js_5.STAGES.findIndex((x) => x.id === sel.stage)) % stages_js_5.STAGES.length].id;
            }
            else {
                this.ladder = null;
            }
            const stage = (0, stages_js_5.getStage)(stageId);
            const match = new Match_js_1.Match({
                mode: sel.mode, p1: CharacterRegistry_js_3.registry.get(sel.p1), p2: CharacterRegistry_js_3.registry.get(p2), stage,
                rounds: s.rounds, time: s.matchTime, seed: (Date.now() & 0xffff) | 1, infiniteEnergy: sel.infiniteEnergy,
            });
            this.match = match;
            this.preview = null;
            this.ai = sel.mode === 'vs-2p' ? null : new CharacterAI_js_1.CharacterAI(match.battle, 1, difficulty, sel.mode === 'practice' ? sel.aiMode : 'normal', (Date.now() & 0xfff) + 5);
            this.input.p2Enabled = sel.mode === 'vs-2p';
            this.animators = [new FighterModel_js_1.FighterAnimator(), new FighterModel_js_1.FighterAnimator()];
            this.vfx.clear();
            this.hud.reset();
            this.stageRenderer.setStage(stage, this.quality);
            this.camera.setMode('intro');
            this.resultShown = false;
            this.acc = 0;
            this.timeScale.reset();
            this.camera.clearFocus();
            match.onPhase = (phase, m) => this.onPhase(phase, m);
            this.screens.hide();
            this.hud.show(true);
            this.state = 'battle';
            this.input.flush();
            this.applySettings();
            this.audio.startMusic();
            this.audio.play('bell');
        }
        ladderOwner = '';
        makeLadder(p1) {
            const others = CharacterRegistry_js_3.registry.list().map((c) => c.id).filter((id) => id !== p1);
            const pool = others.length > 0 ? others : [p1];
            this.ladder = { index: 0, opponents: Array.from({ length: 5 }, (_, i) => pool[i % pool.length]) };
            this.ladderOwner = p1;
        }
        onPhase(phase, m) {
            switch (phase) {
                case 'intro':
                    this.timeScale.reset();
                    this.camera.clearFocus();
                    this.camera.setMode('intro');
                    this.input.flush();
                    if (m.round > 1)
                        this.audio.play('bell');
                    break;
                case 'fight':
                    this.camera.setMode('fight');
                    this.audio.play('bell');
                    this.input.flush();
                    break;
                case 'ko': {
                    const o = m.lastOutcome;
                    if (o && o.winner >= 0 && !o.timeout) {
                        this.camera.setKoFocus(1 - o.winner);
                        this.camera.setMode('ko');
                    }
                    else {
                        this.camera.setMode('fight');
                    }
                    break;
                }
                case 'over':
                    this.timeScale.reset();
                    this.camera.clearFocus();
                    this.camera.setMode('victory');
                    break;
            }
        }
        restart() {
            if (this.lastSel)
                this.startMatch(this.lastSel);
        }
        toMenu() {
            this.endOnline();
            this.state = 'menu';
            this.match = null;
            this.ai = null;
            this.ladder = null;
            this.input.p2Enabled = false;
            this.input.releaseAll();
            this.audio.beamLoop(0);
            this.audio.stopMusic();
            this.hud.show(false);
            this.vfx.clear();
            this.timeScale.reset();
            this.camera.clearFocus();
            const sel = this.lastSel ?? this.screens.selection;
            this.setPreview(sel.p1, sel.p2, sel.stage);
            this.screens.show('main');
            this.applySettings();
        }
        // --------------------------------------------------------------- online
        serverUrl() {
            const cfg = window.UFE_SERVER;
            if (cfg && /^wss?:\/\//.test(cfg))
                return cfg;
            return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
        }
        beginOnline(sel, code) {
            this.endOnline();
            this.audio.unlock();
            this.lastSel = { ...sel };
            const s = this.save.settings;
            const session = new OnlineSession_js_1.OnlineSession(this.serverUrl(), sel.p1, { stage: sel.stage, rounds: s.rounds, time: s.matchTime }, {
                status: (text, c) => this.screens.setOnlineStatus(text, c ?? '', true),
                start: (cfg, role, lock) => this.startOnlineMatch(cfg, role, lock),
                desync: (tick) => {
                    this.screens.toast(`Connection desync detected at tick ${tick}. Leaving the match.`);
                    this.toMenu();
                },
                closed: (reason) => {
                    const inMatch = this.state !== 'menu' && this.match?.cfg.mode === 'online';
                    this.endOnline();
                    if (inMatch)
                        this.toMenuQuiet();
                    this.screens.show('online');
                    this.screens.setOnlineStatus(reason, '', false);
                    this.screens.toast(reason);
                },
            });
            this.online = session;
            if (code)
                session.join(code);
            else
                session.create();
        }
        endOnline() {
            this.online?.close();
            this.online = null;
            this.onlineLock = null;
            this.netBadge?.classList.add('hidden');
        }
        /** Back to the menu without touching the online screen the caller is about to show. */
        toMenuQuiet() {
            this.state = 'menu';
            this.match = null;
            this.input.releaseAll();
            this.audio.beamLoop(0);
            this.audio.stopMusic();
            this.hud.show(false);
            this.vfx.clear();
            this.timeScale.reset();
            this.camera.clearFocus();
            this.setPreview(this.screens.selection.p1, this.screens.selection.p2, this.screens.selection.stage);
            this.applySettings();
        }
        leaveOnlineMatch() {
            this.toMenu();
        }
        startOnlineMatch(cfg, role, lock) {
            this.audio.unlock();
            const match = new Match_js_1.Match({
                mode: 'online', p1: CharacterRegistry_js_3.registry.get(cfg.p1), p2: CharacterRegistry_js_3.registry.get(cfg.p2), stage: (0, stages_js_5.getStage)(cfg.stage),
                rounds: cfg.rounds, time: cfg.time, seed: cfg.seed,
            });
            this.onlineLock = lock;
            this.match = match;
            this.preview = null;
            this.ai = null;
            this.input.p2Enabled = false;
            this.animators = [new FighterModel_js_1.FighterAnimator(), new FighterModel_js_1.FighterAnimator()];
            this.vfx.clear();
            this.hud.reset();
            this.stageRenderer.setStage(match.cfg.stage, this.quality);
            this.camera.setMode('intro');
            this.resultShown = false;
            this.acc = 0;
            this.stallSince = 0;
            this.timeScale.reset();
            this.camera.clearFocus();
            match.onPhase = (phase, m) => this.onPhase(phase, m);
            this.screens.hide();
            this.hud.show(true);
            this.state = 'battle';
            this.input.flush();
            this.applySettings();
            this.audio.startMusic();
            this.audio.play('bell');
            void role;
        }
        /** Online replacement for tick(): sample + send my input, then step only when both inputs for this tick exist. */
        onlineTick() {
            const m = this.match;
            const lock = this.onlineLock;
            const net = this.online;
            if (lock.canCapture()) {
                net.sendInput(lock.capture(this.input.sample(0)));
                this.input.endTick();
            }
            if (!lock.canStep())
                return false;
            m.step(exports.STEP, lock.step());
            this.stats.steps++;
            net.reportState(lock.simTick, () => (0, Lockstep_js_2.hashBattle)(m.battle));
            const b = m.battle;
            if (b.events.length > 0) {
                for (const e of b.events)
                    this.onEvent(e, b);
                b.events.length = 0;
            }
            return true;
        }
        updateNetBadge(now) {
            const el = this.netBadge;
            if (!el)
                return;
            const net = this.online;
            if (!net?.lock || this.state !== 'battle') {
                el.classList.add('hidden');
                return;
            }
            const stalled = this.stallSince > 0 && now - this.stallSince > 400;
            el.classList.remove('hidden');
            el.classList.toggle('bad', stalled);
            el.textContent = stalled ? 'Waiting for opponent...' : `Online · delay ${net.lock.delay * 17} ms`;
            if (this.stallSince > 0 && now - this.stallSince > 10000) {
                this.screens.toast('Opponent stopped responding.');
                this.toMenu();
            }
        }
        // ---------------------------------------------------------------- pause
        togglePause() {
            if (this.online?.lock) {
                // No pausing a live networked match; Esc twice leaves it.
                const now = performance.now();
                if (now - this.escArmedAt < 2000)
                    this.leaveOnlineMatch();
                else {
                    this.escArmedAt = now;
                    this.screens.toast('Press Esc again to leave the online match.');
                }
                return;
            }
            if (this.state === 'battle')
                this.pause();
            else if (this.state === 'paused') {
                if (this.screens.screen === 'pause')
                    this.resume();
                else
                    this.screens.show('pause');
            }
        }
        pause() {
            if (this.online)
                return;
            if (this.state !== 'battle' || !this.match || this.match.phase === 'over')
                return;
            this.state = 'paused';
            this.timeScale.reset();
            this.camera.clearFocus();
            this.input.releaseAll();
            this.audio.beamLoop(0);
            this.screens.show('pause');
            this.updateBodyClasses();
        }
        resume() {
            if (this.state !== 'paused')
                return;
            this.state = 'battle';
            this.screens.hide();
            this.input.flush();
            this.lastTime = performance.now();
        }
        // --------------------------------------------------------------- result
        showResult(m) {
            this.resultShown = true;
            const b = m.battle;
            const [f1, f2] = b.fighters;
            const w = m.matchWinner ?? -1;
            const sel = this.lastSel;
            const mode = m.cfg.mode;
            const vs2p = mode === 'vs-2p';
            const online = mode === 'online';
            const me = this.onlineLock?.localIndex ?? 0;
            const secs = Math.round(m.elapsed);
            const rank = !vs2p && !online ? m.rank() : undefined;
            const outcome = w === -1 ? 'draw' : online ? (w === me ? 'win' : 'lose') : w === 0 ? 'win' : vs2p ? 'win' : 'lose';
            const winnerName = w === 0 ? f1.def.name : w === 1 ? f2.def.name : '';
            const lines = [
                `Rounds: ${m.wins[0]} - ${m.wins[1]}`,
                `Time: ${secs}s`,
                `${f1.def.name}: dealt ${Math.round(f1.damageDealt)} dmg, best combo ${f1.maxCombo}, counters ${f1.counters}`,
                `${f2.def.name}: dealt ${Math.round(f2.damageDealt)} dmg, best combo ${f2.maxCombo}, counters ${f2.counters}`,
            ];
            if (rank)
                lines.push(`Rank: ${rank}`);
            this.save.addMatch({
                at: Date.now(), mode, p1: f1.def.name, p2: f2.def.name, stage: m.cfg.stage.name,
                winner: w === -1 ? 'draw' : (online ? w === me : w === 0) ? 'p1' : 'p2', rounds: `${m.wins[0]}-${m.wins[1]}`, seconds: secs, rank,
            });
            const buttons = [];
            let heading = w === -1 ? (0, strings_js_3.t)('result.draw') : outcome === 'win' ? (0, strings_js_3.t)('result.win') : (0, strings_js_3.t)('result.lose');
            let sub = w === -1 ? 'No winner' : online ? `${winnerName} wins` : vs2p ? `${winnerName} (Player ${w + 1}) wins` : `${winnerName} wins`;
            if (mode === 'battle' && this.ladder) {
                const l = this.ladder;
                if (w === 0) {
                    if (l.index >= 4) {
                        this.save.records.battleBest = 5;
                        this.save.save();
                        heading = 'BATTLE MODE CLEARED';
                        sub = 'All five opponents defeated';
                        buttons.push({ act: 'change', label: (0, strings_js_3.t)('result.change'), primary: true }, { act: 'menu', label: (0, strings_js_3.t)('result.menu') });
                    }
                    else {
                        this.save.records.battleBest = Math.max(this.save.records.battleBest, l.index + 1);
                        this.save.save();
                        sub = `Fight ${l.index + 1} of 5 cleared`;
                        buttons.push({ act: 'next', label: (0, strings_js_3.t)('result.next'), primary: true }, { act: 'menu', label: (0, strings_js_3.t)('result.menu') });
                    }
                }
                else {
                    sub = `Defeated on fight ${l.index + 1} of 5`;
                    buttons.push({ act: 'retry', label: (0, strings_js_3.t)('result.retry'), primary: true }, { act: 'menu', label: (0, strings_js_3.t)('result.menu') });
                }
            }
            else if (online) {
                buttons.push({ act: 'rematch', label: (0, strings_js_3.t)('result.rematch'), primary: true }, { act: 'menu', label: (0, strings_js_3.t)('result.menu') });
            }
            else {
                buttons.push({ act: 'rematch', label: (0, strings_js_3.t)('result.rematch'), primary: true }, { act: 'change', label: (0, strings_js_3.t)('result.change') }, { act: 'menu', label: (0, strings_js_3.t)('result.menu') });
            }
            void sel;
            this.audio.play(outcome === 'lose' ? 'defeat' : 'victory');
            this.screens.showResult({ outcome, heading, sub, lines, buttons });
        }
        resultAction(act) {
            switch (act) {
                case 'rematch':
                    if (this.online) {
                        this.online.requestRematch();
                        this.screens.toast('Rematch requested. Waiting for your opponent...');
                        break;
                    }
                    this.restart();
                    break;
                case 'retry':
                    this.restart();
                    break;
                case 'next':
                    if (this.ladder)
                        this.ladder.index++;
                    this.restart();
                    break;
                case 'change':
                    this.ladder = null;
                    this.toMenu();
                    this.screens.startSelect((this.lastSel ?? this.screens.selection).mode);
                    break;
                default:
                    this.toMenu();
            }
        }
        // --------------------------------------------------------------- events
        onEvent(e, battle) {
            const a = this.audio;
            this.vfx.handle(e, battle);
            switch (e.type) {
                case 'hit':
                    a.play(e.heavy ? 'hitH' : 'hitL', Math.min(1.2, 0.5 + e.strength * 0.5));
                    break;
                case 'block':
                    a.play('block');
                    break;
                case 'counter':
                    a.play('counter');
                    this.hud.message((0, strings_js_3.t)('hud.counter'), 'gold');
                    break;
                case 'guardbreak':
                    a.play('guardbreak');
                    this.hud.message((0, strings_js_3.t)('hud.guardbreak'), 'red');
                    break;
                case 'armor':
                    a.play('armor');
                    break;
                case 'swing':
                    a.play(e.heavy ? 'swingH' : 'swingL');
                    break;
                case 'throw':
                    a.play('throw');
                    break;
                case 'techbreak':
                    a.play('block');
                    this.hud.message((0, strings_js_3.t)('hud.techbreak'), 'blue');
                    break;
                case 'land':
                    a.play('land', Math.min(1.5, 0.4 + e.strength));
                    break;
                case 'dodge':
                    a.play('dodge');
                    break;
                case 'jump':
                    a.play('jump');
                    break;
                case 'stomp':
                    a.play('stomp');
                    break;
                case 'projectile':
                    a.play('projectile');
                    break;
                case 'projectileHit':
                    a.play('projectileHit');
                    break;
                case 'chargeStart':
                    a.play('charge');
                    break;
                case 'beamFire':
                    a.play('beamFire');
                    break;
                case 'clashStart':
                    a.play('clash');
                    break;
                case 'clashEnd':
                    a.play('explosion');
                    break;
                case 'propBroken':
                    a.play('prop');
                    break;
                case 'ko':
                    a.play('ko');
                    this.timeScale.request(0.35, 0.9);
                    this.camera.clearFocus();
                    break;
                case 'timerExpired':
                    this.hud.message((0, strings_js_3.t)('hud.powerlow'), 'red');
                    break;
                case 'transformStart': {
                    const f = battle.fighters[e.fighter];
                    const form = f.baseDef.forms?.[f.pendingForm] ?? null;
                    a.play('charge');
                    this.camera.focus(e.fighter, form?.closeUp ?? 0.35, (0, TransformationSystem_js_5.windupOf)(form) + 0.4);
                    break;
                }
                case 'transform': {
                    const form = battle.fighters[e.fighter].form;
                    a.play('transform', form?.pitch ?? 1);
                    this.hud.message(e.revert ? (0, strings_js_3.t)('hud.revert') : `${(0, strings_js_3.t)('hud.transform')} ${e.form.toUpperCase()}`, e.revert ? 'blue' : 'gold');
                    if (!e.revert) {
                        // Final reveal: a short, strong beat that eases back to the normal camera on its own.
                        this.camera.focus(e.fighter, (form?.closeUp ?? 0.4) * 0.8, 0.45);
                        this.camera.addTrauma(0.3 * (form?.burst ?? 0.6));
                        this.timeScale.request(0.45, 0.28);
                        this.screenFlash(e.color, 0.4 * (form?.burst ?? 0.6));
                    }
                    else {
                        this.camera.clearFocus();
                    }
                    break;
                }
                case 'transformCancel':
                    this.camera.clearFocus();
                    a.play('ultBreak');
                    if (this.isHuman(e.fighter))
                        this.hud.message('TRANSFORM INTERRUPTED', 'red');
                    break;
                case 'ultimateReady':
                    if (this.isHuman(e.fighter)) {
                        a.play('ultReady');
                        this.hud.pulseUltimate(e.fighter);
                    }
                    break;
                case 'ultimateStart': {
                    const u = battle.fighters[e.fighter].def.moves.ultimate;
                    a.play('ultCharge');
                    this.camera.focus(e.fighter, u.cinematic.closeUp, u.attack.startup + 0.7);
                    this.camera.addTrauma(u.cinematic.chargeShake * 0.5);
                    this.hud.message(u.name.toUpperCase(), 'gold');
                    break;
                }
                case 'ultimateFire': {
                    const u = battle.fighters[e.fighter].def.moves.ultimate;
                    a.play(u.sound === 'beam' ? 'ultBeam' : u.sound === 'quake' ? 'ultQuake' : u.sound === 'strike' ? 'ultStrike' : 'ultNova');
                    this.camera.addTrauma(u.cinematic.fireShake);
                    this.timeScale.request(u.cinematic.slowmo, 0.35);
                    this.screenFlash(u.coreColor, 0.45);
                    break;
                }
                case 'ultimateEnd':
                    this.camera.clearFocus();
                    if (e.interrupted) {
                        a.play('ultBreak');
                        this.hud.message('ULTIMATE BROKEN', 'red');
                    }
                    break;
                case 'perfectDodge':
                    a.play('perfect');
                    this.camera.addTrauma(0.1);
                    this.timeScale.request(0.45, 0.28);
                    this.hud.message('PERFECT DODGE', 'blue');
                    break;
                case 'denied':
                    if (this.isHuman(e.fighter)) {
                        a.play('deny');
                        const txt = e.what === 'ultimate'
                            ? (e.reason === 'cooldown' ? 'ULTIMATE RECHARGING' : 'NEED MORE ENERGY')
                            : e.reason === 'none' ? 'NO FORMS' : e.reason === 'cooldown' ? 'FORM RECHARGING' : 'NOT ENOUGH ENERGY';
                        this.hud.message(txt, 'red');
                    }
                    break;
                case 'shake':
                    this.camera.addTrauma(e.amount);
                    break;
                default: break;
            }
        }
        /** Whether sounds and prompts for this fighter should reach the player (the CPU's prompts stay silent). */
        isHuman(index) {
            if (this.match?.cfg.mode === 'online')
                return index === this.onlineLock?.localIndex;
            return index === 0 || this.match?.cfg.mode === 'vs-2p';
        }
        /** Full-screen flash, skipped when the player has reduced camera shake / effects. */
        screenFlash(c, strength) {
            if (this.save.settings.shake)
                this.hud.flash(c, strength);
        }
        // ----------------------------------------------------------------- loop
        start() {
            this.lastTime = performance.now();
            this.renderer.resize();
            const frame = (now) => {
                this.raf = requestAnimationFrame(frame);
                this.frame(now);
            };
            this.raf = requestAnimationFrame(frame);
        }
        stop() {
            cancelAnimationFrame(this.raf);
        }
        /** One browser frame: fixed-step simulation, then render with interpolation. */
        frame(now) {
            const raw = Math.max(0, (now - this.lastTime) / 1000);
            this.lastTime = now;
            const dt = Math.min(raw, 0.1);
            this.time += dt;
            this.stats.frames++;
            this.governQuality(raw);
            if (this.state === 'battle' && this.match) {
                // Slow motion scales how fast the simulation, effects and animation advance - never camera, HUD or input.
                const scale = this.online ? 1 : this.timeScale.update(dt);
                this.simDt = dt * scale;
                this.acc += this.simDt;
                let steps = 0;
                while (this.acc >= exports.STEP && steps < MAX_STEPS) {
                    if (this.online) {
                        if (!this.onlineTick()) {
                            // Opponent's input for this tick has not arrived yet: wait (never run ahead), and don't bank time.
                            if (this.stallSince === 0)
                                this.stallSince = now;
                            this.acc = Math.min(this.acc, exports.STEP * 3);
                            this.simDt = 0;
                            break;
                        }
                        this.stallSince = 0;
                    }
                    else {
                        this.tick();
                    }
                    this.acc -= exports.STEP;
                    steps++;
                }
                if (steps === MAX_STEPS)
                    this.acc = 0;
                if (this.online)
                    this.updateNetBadge(now);
                const m = this.match;
                this.vfx.update(this.simDt, m.battle);
                this.audio.beamLoop(this.vfx.beamPower > 0 ? Math.min(1.5, this.vfx.beamPower / 2) : 0);
                this.hud.update(m, dt);
                if (m.phase === 'over' && !this.resultShown)
                    this.showResult(m);
            }
            else if (this.state === 'menu' && this.preview) {
                this.timeScale.reset();
                this.simDt = dt;
                this.preview.step(dt, [(0, types_js_5.emptyInput)(), (0, types_js_5.emptyInput)()]);
                this.preview.events.length = 0;
                this.vfx.update(dt, null);
            }
            this.render(dt);
        }
        tick() {
            const m = this.match;
            const p1 = this.input.sample(0);
            const p2 = this.ai ? this.ai.update(exports.STEP) : this.input.sample(1);
            m.step(exports.STEP, [p1, p2]);
            this.input.endTick();
            this.stats.steps++;
            const b = m.battle;
            if (b.events.length > 0) {
                for (const e of b.events)
                    this.onEvent(e, b);
                b.events.length = 0;
            }
        }
        render(dt) {
            if (this.renderer.contextLost)
                return;
            const battle = this.match?.battle ?? this.preview;
            if (!battle)
                return;
            const alpha = this.state === 'battle' ? this.acc / exports.STEP : 1;
            this.camera.update(dt, battle, this.renderer.aspect, this.time);
            this.renderer.beginFrame(this.camera.state, this.stageRenderer.environment(), this.time);
            this.stageRenderer.draw(battle, this.time, this.camera.state.eye, this.camera.state.target);
            for (let i = 0; i < 2; i++) {
                const f = battle.fighters[i];
                this.animators[i].update(f, this.state === 'paused' ? 0 : this.simDt, this.time);
                (0, FighterModel_js_1.drawFighter)(this.renderer, f, this.animators[i], alpha, this.time);
            }
            this.vfx.draw(this.renderer, battle, this.time);
        }
        /** In "auto" quality, step down once if the device consistently cannot keep up. Never steps back up. */
        governQuality(rawDt) {
            if (this.save.settings.quality !== 'auto' || this.state === 'paused' || document.hidden)
                return;
            const ms = Math.min(100, rawDt * 1000);
            this.frameEma += (ms - this.frameEma) * 0.05;
            if (this.frameEma > 28)
                this.slowFrames++;
            else
                this.slowFrames = Math.max(0, this.slowFrames - 2);
            if (this.slowFrames > 150) {
                this.slowFrames = 0;
                const next = this.quality === 'high' ? 'medium' : this.quality === 'medium' ? 'low' : null;
                if (next) {
                    this.slowQuality = next;
                    this.setQuality(next);
                    this.frameEma = 16;
                    this.screens.toast(`Performance: graphics lowered to ${next}`);
                }
            }
        }
        get qualityLevel() {
            return this.quality;
        }
    }
    exports.Game = Game;
});
define("main", ["require", "exports", "app/Game"], function (require, exports, Game_js_1) {
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    function fail(message) {
        const el = document.getElementById('loading');
        if (!el)
            return;
        el.classList.remove('hidden');
        el.innerHTML = `<div class="loading-box err"><h2>Could not start the game</h2><p></p></div>`;
        const p = el.querySelector('p');
        if (p)
            p.textContent = message;
    }
    function boot() {
        const canvas = document.getElementById('game');
        const hud = document.getElementById('hud');
        const screens = document.getElementById('screens');
        const touch = document.getElementById('touch');
        if (!canvas || !hud || !screens) {
            fail('The page is missing required elements (game, hud, screens).');
            return;
        }
        try {
            const game = new Game_js_1.Game(canvas, hud, screens, touch);
            window.__ufe = game;
            game.start();
            document.getElementById('loading')?.classList.add('hidden');
        }
        catch (e) {
            console.error(e);
            fail(e instanceof Error ? e.message : String(e));
        }
    }
    window.addEventListener('error', (e) => {
        console.error('Unhandled error:', e.error ?? e.message);
    });
    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', boot);
    else
        boot();
});

__bootGame('main');
