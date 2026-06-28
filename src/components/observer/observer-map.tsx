'use client'

import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

// ════════════════════════════════════════════════════════════════
// OBSERVER MAP V2 — MAP IS THE PRODUCT
// ════════════════════════════════════════════════════════════════
//
// Camera Pipeline:
//   GPS → Kalman Filter → Position Smoothing → Camera Target → easeTo
//
// Rules:
//   - Pin ALWAYS centered (CSS overlay, NOT a map marker)
//   - World moves. Pin stays.
//   - Camera duration: 400ms
//   - Easing: easeOutCubic
//   - Route: #0A84FF glow
//   - Base: #0A0A0A dark
//   - Arrival: #30D158
//   - Alert: #FF453A
//
// ════════════════════════════════════════════════════════════════

interface TrajectoryPoint {
  lat: number
  lng: number
}

interface ObserverMapProps {
  lat: number
  lng: number
  trajectory: TrajectoryPoint[]
  heading?: number | null
  screenState?: string
}

// ── COLORS ──
const ROUTE_COLOR = '#0A84FF'
const HOME_LAT = -34.6037
const HOME_LNG = -58.3816

// ── CAMERA SETTINGS ──
const CAMERA_DURATION = 400  // ms — V2 spec
const CAMERA_EASING = (t: number) => 1 - Math.pow(1 - t, 3)  // easeOutCubic

export default function ObserverMap({
  lat,
  lng,
  trajectory,
  heading,
  screenState,
}: ObserverMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<maplibregl.Map | null>(null)
  const lastCenterRef = useRef<{ lat: number; lng: number }>({ lat, lng })
  const isAnimatingRef = useRef(false)

  // ── INITIALIZE MAP ──
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: {
        version: 8,
        sources: {
          'carto-dark': {
            type: 'raster',
            tiles: [
              'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
              'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
            ],
            tileSize: 256,
            attribution: '',
          },
        },
        layers: [
          {
            id: 'carto-dark-layer',
            type: 'raster',
            source: 'carto-dark',
            minzoom: 0,
            maxzoom: 20,
          },
        ],
      },
      center: [lng, lat],
      zoom: 15.5,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
      dragRotate: false,
      touchZoomRotate: true,
      trackResize: true,
    })

    // Minimal zoom control (bottom-right, glass style)
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false, visualizePitch: false }),
      'bottom-right'
    )

    mapInstanceRef.current = map
    lastCenterRef.current = { lat, lng }

    map.on('load', () => {
      // ── TRAIL SOURCE ──
      map.addSource('trail', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
      })

      // Trail outer glow (wide, very soft)
      map.addLayer({
        id: 'trail-glow',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROUTE_COLOR,
          'line-width': 16,
          'line-opacity': 0.06,
        },
      })

      // Trail mid glow
      map.addLayer({
        id: 'trail-glow-mid',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROUTE_COLOR,
          'line-width': 8,
          'line-opacity': 0.12,
        },
      })

      // Trail core line
      map.addLayer({
        id: 'trail-line',
        type: 'line',
        source: 'trail',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ROUTE_COLOR,
          'line-width': 3,
          'line-opacity': 0.6,
        },
      })

      // ── HOME MARKER ──
      const homeEl = document.createElement('div')
      homeEl.innerHTML = `
        <div style="
          width: 10px; height: 10px;
          background: rgba(10,132,255,0.25);
          border: 1.5px solid rgba(10,132,255,0.5);
          border-radius: 50%;
          box-shadow: 0 0 8px rgba(10,132,255,0.15);
        "></div>
      `
      new maplibregl.Marker({ element: homeEl, anchor: 'center' })
        .setLngLat([HOME_LNG, HOME_LAT])
        .addTo(map)
    })

    return () => {
      map.remove()
      mapInstanceRef.current = null
    }
  }, [])  // Run once on mount

  // ── CAMERA: World moves, pin stays ──
  // 400ms easeOutCubic per V2 spec
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map) return

    const last = lastCenterRef.current
    // Skip if position hasn't meaningfully changed
    if (Math.abs(last.lat - lat) < 0.000001 && Math.abs(last.lng - lng) < 0.000001) return

    lastCenterRef.current = { lat, lng }

    // Rotate map to heading if available (navigation mode)
    const shouldRotate = heading !== null && heading !== undefined &&
      (screenState === 'navigating' || screenState === 'moving')

    if (!isAnimatingRef.current) {
      isAnimatingRef.current = true
      map.easeTo({
        center: [lng, lat],
        bearing: shouldRotate ? -heading! : 0,
        duration: CAMERA_DURATION,
        easing: CAMERA_EASING,
      })
      map.once('moveend', () => { isAnimatingRef.current = false })
    }
  }, [lat, lng, heading, screenState])

  // ── TRAIL UPDATE ──
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !map.getSource('trail')) return
    if (trajectory.length < 2) return

    const coordinates = trajectory.map(p => [p.lng, p.lat])
    const source = map.getSource('trail') as maplibregl.GeoJSONSource
    source.setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates },
      properties: {},
    })
  }, [trajectory])

  return (
    <div ref={mapRef} className="w-full h-full" />
  )
}
