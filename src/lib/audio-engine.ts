// ════════════════════════════════════════════════════════════════
// V2 AMBIENT AUDIO ENGINE — PROXIMITY-BASED SOUND TRIGGERS
// ════════════════════════════════════════════════════════════════
//
// PHILOSOPHY:
//   ❌ Sound is NEVER an alarm, popup, or interruptive alert
//   ✔ Sound = emotional layer (atmosphere, not notification)
//   ✔ Silence = valid state (means uncertainty, not absence)
//   ✔ Proximity triggers create ambient emotional context
//
// RULES:
//   Rule 1 — "CAR ACCELERATING" (5s)
//     Triggered when: distanceToHome <= 200m, confidence >= 0.65,
//                     movementState = VEHICULAR/HIGH_SPEED
//     Sound: Low-freq rumble 80Hz → 200Hz, volume 0.35
//
//   Rule 2 — "HEELS + CAR" (10s)
//     Triggered when: distanceToHome <= 200m, confidence >= 0.75,
//                     movementState = WALKING
//     Sound: Rhythmic clicking ~800Hz over low rumble, volume 0.4
//
//   Rule 3 — "SILENCE" (ambient)
//     When confidence < 0.4 or NO_SIGNAL — silence = uncertainty
//
// ════════════════════════════════════════════════════════════════

// ── TYPES ──

export interface AudioRuleContext {
  distanceToHome: number
  confidence: number
  movementState: string
  hasSignal: boolean
}

type SoundRule = 'car_accelerate' | 'heels_and_car' | 'silence'

// ── CONSTANTS ──

const COOLDOWN_MS = 15_000
const MASTER_VOLUME = 0.7

// ── AUDIO ENGINE CLASS ──

class AudioEngine {
  private ctx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private activeSounds: Map<string, AudioNode> = new Map()
  private lastTrigger: Map<SoundRule, number> = new Map()
  private _initialized = false
  private _disposed = false

  init(): void {
    if (this._initialized || this._disposed) return
    try {
      this.ctx = new AudioContext()
      this.masterGain = this.ctx.createGain()
      this.masterGain.gain.value = MASTER_VOLUME
      this.masterGain.connect(this.ctx.destination)
      this._initialized = true
    } catch {
      // WebAudio not available — silent mode
    }
  }

  evaluateRules(context: AudioRuleContext): SoundRule | null {
    if (!context.hasSignal || context.confidence < 0.4) return 'silence'
    if (context.distanceToHome > 200) return null
    if (context.movementState === 'WALKING' && context.confidence >= 0.75) return 'heels_and_car'
    if ((context.movementState === 'VEHICULAR' || context.movementState === 'HIGH_SPEED' || context.movementState === 'MOVING' || context.movementState === 'FAST_MOVING') && context.confidence >= 0.65) return 'car_accelerate'
    return null
  }

  trigger(context: AudioRuleContext): void {
    if (!this._initialized || this._disposed) return
    const rule = this.evaluateRules(context)
    if (rule === 'silence') { this.stopAll(); return }
    if (rule === null) return

    const now = Date.now()
    const lastTime = this.lastTrigger.get(rule) ?? 0
    if (now - lastTime < COOLDOWN_MS) return
    this.lastTrigger.set(rule, now)

    switch (rule) {
      case 'car_accelerate': this.playCarAccelerate(); break
      case 'heels_and_car': this.playHeelsAndCar(); break
    }
  }

  playCarAccelerate(): void {
    if (!this.ctx || !this.masterGain || this._disposed) return
    const now = this.ctx.currentTime
    const volume = 0.35
    const duration = 5.0

    const osc = this.ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(80, now)
    osc.frequency.exponentialRampToValueAtTime(200, now + duration)

    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(0.001, now)
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.8)
    gain.gain.setValueAtTime(volume, now + duration - 1.0)
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration)

    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(300, now)
    filter.frequency.exponentialRampToValueAtTime(600, now + duration)
    filter.Q.value = 1.0

    osc.connect(filter)
    filter.connect(gain)
    gain.connect(this.masterGain)

    const soundId = `car_${now}`
    this.activeSounds.set(soundId, gain)
    osc.onended = () => { osc.disconnect(); filter.disconnect(); gain.disconnect(); this.activeSounds.delete(soundId) }
    osc.start(now)
    osc.stop(now + duration)
  }

  playHeelsAndCar(): void {
    if (!this.ctx || !this.masterGain || this._disposed) return
    const now = this.ctx.currentTime
    const volume = 0.4
    const duration = 10.0

    // Car rumble
    const carOsc = this.ctx.createOscillator()
    carOsc.type = 'sawtooth'
    carOsc.frequency.setValueAtTime(80, now)
    carOsc.frequency.linearRampToValueAtTime(120, now + duration * 0.5)
    carOsc.frequency.linearRampToValueAtTime(80, now + duration)

    const carGain = this.ctx.createGain()
    carGain.gain.setValueAtTime(0.001, now)
    carGain.gain.exponentialRampToValueAtTime(volume * 0.3, now + 1.0)
    carGain.gain.setValueAtTime(volume * 0.3, now + duration - 1.5)
    carGain.gain.exponentialRampToValueAtTime(0.001, now + duration)

    const carFilter = this.ctx.createBiquadFilter()
    carFilter.type = 'lowpass'
    carFilter.frequency.value = 250
    carFilter.Q.value = 0.7

    carOsc.connect(carFilter)
    carFilter.connect(carGain)
    carGain.connect(this.masterGain)

    // Heels clicking
    const heelsGain = this.ctx.createGain()
    heelsGain.gain.setValueAtTime(0.001, now)
    heelsGain.gain.exponentialRampToValueAtTime(volume, now + 0.5)
    heelsGain.gain.setValueAtTime(volume, now + duration - 1.0)
    heelsGain.gain.exponentialRampToValueAtTime(0.001, now + duration)

    const panner = this.ctx.createStereoPanner()
    heelsGain.connect(panner)
    panner.connect(this.masterGain)

    const totalClicks = Math.floor(duration * 2)
    const heelOscs: OscillatorNode[] = []
    for (let i = 0; i < totalClicks; i++) {
      const clickTime = now + i * 0.5
      const clickOsc = this.ctx.createOscillator()
      clickOsc.type = 'sine'
      clickOsc.frequency.setValueAtTime(800 + (Math.random() - 0.5) * 30, clickTime)

      const clickGain = this.ctx.createGain()
      clickGain.gain.setValueAtTime(0.001, clickTime)
      clickGain.gain.exponentialRampToValueAtTime(volume * 0.7, clickTime + 0.005)
      clickGain.gain.exponentialRampToValueAtTime(0.001, clickTime + 0.04)

      clickOsc.connect(clickGain)
      clickGain.connect(heelsGain)
      clickOsc.start(clickTime)
      clickOsc.stop(clickTime + 0.05)
      heelOscs.push(clickOsc)

      // Spatial panning
      const panValue = Math.sin(i / totalClicks * Math.PI * 2) * 0.4
      panner.pan.setValueAtTime(panValue, clickTime)
    }

    const soundId = `heels_${now}`
    this.activeSounds.set(soundId, heelsGain)
    carOsc.onended = () => { carOsc.disconnect(); carFilter.disconnect(); carGain.disconnect() }
    const lastHeel = heelOscs[heelOscs.length - 1]
    if (lastHeel) {
      lastHeel.onended = () => {
        heelOscs.forEach(o => { try { o.disconnect() } catch {} })
        heelsGain.disconnect()
        panner.disconnect()
        this.activeSounds.delete(soundId)
      }
    }
    carOsc.start(now)
    carOsc.stop(now + duration)
  }

  stopAll(): void {
    if (!this.ctx || this._disposed) return
    const now = this.ctx.currentTime
    if (this.masterGain) {
      this.masterGain.gain.setValueAtTime(this.masterGain.gain.value, now)
      this.masterGain.gain.exponentialRampToValueAtTime(0.001, now + 0.3)
      setTimeout(() => {
        if (this.masterGain && this.ctx) {
          this.masterGain.gain.setValueAtTime(MASTER_VOLUME, this.ctx!.currentTime)
        }
      }, 350)
    }
    setTimeout(() => {
      this.activeSounds.forEach(node => { try { node.disconnect() } catch {} })
      this.activeSounds.clear()
    }, 350)
  }

  isInitialized(): boolean { return this._initialized }
  isDisposed(): boolean { return this._disposed }

  dispose(): void {
    if (this._disposed) return
    this.activeSounds.forEach(node => { try { node.disconnect() } catch {} })
    this.activeSounds.clear()
    if (this.masterGain) { try { this.masterGain.disconnect() } catch {}; this.masterGain = null }
    if (this.ctx) { this.ctx.close().catch(() => {}); this.ctx = null }
    this.lastTrigger.clear()
    this._initialized = false
    this._disposed = true
  }
}

export const audioEngine = new AudioEngine()
