-- ============================================================
-- 003_sante.sql — Organización y configuración base
-- Sante Healthy Hair Salon (Alicante)
-- ============================================================

-- Organización (UUID fijo para referenciarlo en .env)
INSERT INTO organizations (id, name, slug, timezone)
VALUES (
  'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  'Sante Healthy Hair Salon',
  'sante-healthy-hair-salon',
  'Europe/Madrid'
)
ON CONFLICT (id) DO NOTHING;

-- Configuración del agente
INSERT INTO agent_configs (organization_id, system_prompt, tone, business_info, services, business_hours, handoff_message)
VALUES (
  'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  '',
  'cercano, cálido y profesional',
  '{
    "companyName": "Sante Healthy Hair Salon",
    "botName": "Asistente de Santé",
    "idiomas": ["español", "inglés", "ruso", "ucraniano"],
    "direccion": "Calle San Juan Bosco 14, Alicante 03005",
    "whatsapp": "641029104",
    "googleReviewLink": "https://maps.app.goo.gl/PGdw5KeetLKbbdk18",
    "cancelacion": "Avisar con 48 horas de antelación",
    "horasResena": 2,
    "stripe": {
      "activo": false,
      "deposito": 10,
      "nota": "Placeholder — activar más adelante"
    },
    "equipo": [
      { "nombre": "Veronika", "rol": "colorista/estilista" },
      { "nombre": "Irina", "rol": "colorista/estilista" },
      { "nombre": "Yulia", "rol": "colorista/estilista + diagnóstico capilar" },
      { "nombre": "Olgha", "rol": "manicura/pedicura", "disponibilidad": "martes, jueves y viernes" },
      { "nombre": "Larisa", "rol": "masajes/spa" }
    ],
    "upselling": [
      { "servicio": "Color raíz", "sugerencias": ["Manicura (solo martes/jueves/viernes)", "Pedicura", "Diagnóstico capilar"] },
      { "servicio": "Balayage", "sugerencias": ["K18", "Pro-Miracle"] },
      { "servicio": "Corte", "sugerencias": ["Exfoliación del cuero cabelludo"] },
      { "servicio": "Tricología", "sugerencias": ["Dermapen", "LED"] }
    ]
  }'::JSONB,
  '[
    { "categoria": "Alisado vegano", "nombre": "Largo 1", "precio": 210, "duracion": 300 },
    { "categoria": "Alisado vegano", "nombre": "Largo 2", "precio": 260, "duracion": 300 },
    { "categoria": "Alisado vegano", "nombre": "Largo 3", "precio": 310, "duracion": 300 },

    { "categoria": "Anti-encrespamiento", "nombre": "Largo 1", "precio": 120, "duracion": 240 },
    { "categoria": "Anti-encrespamiento", "nombre": "Largo 2", "precio": 160, "duracion": 240 },
    { "categoria": "Anti-encrespamiento", "nombre": "Largo 3", "precio": 180, "duracion": 240 },

    { "categoria": "Brillo Glow", "nombre": "Brillo intensivo", "precio": 120, "duracion": 180 },

    { "categoria": "Color Premium", "nombre": "Color raíz", "precio": 75, "duracion": 120 },
    { "categoria": "Color Premium", "nombre": "Color completo largo 1", "precio": 90, "duracion": 120 },
    { "categoria": "Color Premium", "nombre": "Color completo largo 2", "precio": 100, "duracion": 120 },
    { "categoria": "Color Premium", "nombre": "Color completo largo 3", "precio": 110, "duracion": 120 },
    { "categoria": "Color Premium", "nombre": "Ampolla cuidado", "precio": 10, "duracion": 5 },

    { "categoria": "Cortes", "nombre": "Mujer y peinado Dyson", "precio": 50, "duracion": 60 },
    { "categoria": "Cortes", "nombre": "Mujer y secado", "precio": 40, "duracion": 45 },
    { "categoria": "Cortes", "nombre": "Hombre", "precio": 25, "duracion": 30 },
    { "categoria": "Cortes", "nombre": "Niño", "precio": 25, "duracion": 60 },
    { "categoria": "Cortes", "nombre": "Infantil hasta 8 años", "precio": 15, "duracion": 60 },

    { "categoria": "Deco Total Blond", "nombre": "Largo 1", "precio": 125, "duracion": 120 },
    { "categoria": "Deco Total Blond", "nombre": "Largo 2", "precio": 145, "duracion": 120 },
    { "categoria": "Deco Total Blond", "nombre": "Largo 3", "precio": 165, "duracion": 120 },
    { "categoria": "Deco Total Blond", "nombre": "Largo 4", "precio": 175, "duracion": 140 },

    { "categoria": "Dermapen Hair Loss", "nombre": "Dermapen Hair Loss", "precio": 75, "duracion": 90 },

    { "categoria": "Diagnóstico Capilar", "nombre": "Consulta tricológica con Yulia", "precio": 85, "duracion": 60 },

    { "categoria": "Exfoliación cabeza", "nombre": "Exfoliación/pilling", "precio": 10, "duracion": 20 },

    { "categoria": "Lavar y peinar", "nombre": "Señora", "precio": 25, "duracion": 60 },
    { "categoria": "Lavar y peinar", "nombre": "Peinado alisar", "precio": 35, "duracion": 60 },
    { "categoria": "Lavar y peinar", "nombre": "Peinado ondas", "precio": 40, "duracion": 60 },
    { "categoria": "Lavar y peinar", "nombre": "Peinado especial", "precio": 45, "duracion": 90 },

    { "categoria": "Manicura/Pedicura", "nombre": "Higiénica mujer", "precio": 25, "duracion": 120 },
    { "categoria": "Manicura/Pedicura", "nombre": "Hombre", "precio": 25, "duracion": 60 },
    { "categoria": "Manicura/Pedicura", "nombre": "Manicure + gel", "precio": 35, "duracion": 120 },
    { "categoria": "Manicura/Pedicura", "nombre": "Extensión uñas", "precio": 45, "duracion": 120 },
    { "categoria": "Manicura/Pedicura", "nombre": "Corrección uñas ext", "precio": 40, "duracion": 120 },
    { "categoria": "Manicura/Pedicura", "nombre": "Pedicura higiénica", "precio": 35, "duracion": 120 },
    { "categoria": "Manicura/Pedicura", "nombre": "Pedicura + esmaltado", "precio": 45, "duracion": 120 },
    { "categoria": "Manicura/Pedicura", "nombre": "Japonesa", "precio": 25, "duracion": 50 },
    { "categoria": "Manicura/Pedicura", "nombre": "Fortalecimiento gel", "precio": 5, "duracion": 30 },
    { "categoria": "Manicura/Pedicura", "nombre": "Diseño", "precio": 5, "duracion": 20 },
    { "categoria": "Manicura/Pedicura", "nombre": "Reparación 1 uña", "precio": 5, "duracion": 15 },

    { "categoria": "Masajes y SPA", "nombre": "Relajante completo", "precio": 70, "duracion": 60 },
    { "categoria": "Masajes y SPA", "nombre": "Espalda y hombros", "precio": 45, "duracion": 45 },
    { "categoria": "Masajes y SPA", "nombre": "Premium", "precio": 95, "duracion": 90 },
    { "categoria": "Masajes y SPA", "nombre": "Drenaje linfático piernas", "precio": 45, "duracion": 40 },
    { "categoria": "Masajes y SPA", "nombre": "Anticelulítico", "precio": 65, "duracion": 45 },
    { "categoria": "Masajes y SPA", "nombre": "Drenaje corporal", "precio": 75, "duracion": 60 },
    { "categoria": "Masajes y SPA", "nombre": "Aromaterapia relax", "precio": 75, "duracion": 60 },
    { "categoria": "Masajes y SPA", "nombre": "Deportivo", "precio": 65, "duracion": 60 },
    { "categoria": "Masajes y SPA", "nombre": "Facial reafirmante", "precio": 40, "duracion": 30 },

    { "categoria": "Matiz mujer", "nombre": "Matiz", "precio": 40, "duracion": 60 },
    { "categoria": "Matiz mujer", "nombre": "Matiz plus", "precio": 65, "duracion": 60 },
    { "categoria": "Matiz mujer", "nombre": "Mascarilla violeta", "precio": 10, "duracion": 15 },

    { "categoria": "Mechas Airtouch", "nombre": "Largo 1", "precio": 195, "duracion": 360 },
    { "categoria": "Mechas Airtouch", "nombre": "Largo 2", "precio": 220, "duracion": 360 },
    { "categoria": "Mechas Airtouch", "nombre": "Largo 3", "precio": 235, "duracion": 360 },
    { "categoria": "Mechas Airtouch", "nombre": "Largo 4", "precio": 260, "duracion": 360 },

    { "categoria": "Mechas clásicas", "nombre": "Mechas 1", "precio": 60, "duracion": 90 },
    { "categoria": "Mechas clásicas", "nombre": "Mechas 2", "precio": 80, "duracion": 180 },
    { "categoria": "Mechas clásicas", "nombre": "Mechas 3", "precio": 100, "duracion": 180 },

    { "categoria": "Mechas Contouring", "nombre": "Mechas Contouring", "precio": 160, "duracion": 200 },

    { "categoria": "Reconstrucción", "nombre": "Pro Miracle Repair TEMPTING", "precio": 65, "duracion": 60 },
    { "categoria": "Reconstrucción", "nombre": "K18", "precio": 45, "duracion": 60 },

    { "categoria": "Retocar", "nombre": "Retocar mujer", "precio": 25, "duracion": 40 },

    { "categoria": "Spa Hair", "nombre": "Relax 45min", "precio": 85, "duracion": 45 },
    { "categoria": "Spa Hair", "nombre": "Detox 60min", "precio": 115, "duracion": 60 },
    { "categoria": "Spa Hair", "nombre": "Hidratación 60min", "precio": 110, "duracion": 60 },

    { "categoria": "Tratamiento Orgánico", "nombre": "Orising hidratación intensa", "precio": 85, "duracion": 90 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Orising express", "precio": 60, "duracion": 90 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Orising anticaída", "precio": 85, "duracion": 120 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Orising anticaspa", "precio": 85, "duracion": 120 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Green Purity Detox", "precio": 35, "duracion": 40 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Fresh Hidratación", "precio": 45, "duracion": 40 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Miracle Elixir", "precio": 59, "duracion": 60 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Pure Defense", "precio": 59, "duracion": 60 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Nature Boost", "precio": 65, "duracion": 60 },
    { "categoria": "Tratamiento Orgánico", "nombre": "Botanical Glow Pure Blond", "precio": 45, "duracion": 40 }
  ]'::JSONB,
  '{
    "lunes":     { "apertura": "10:00", "cierre": "19:00" },
    "martes":    { "apertura": "10:00", "cierre": "19:00" },
    "miercoles": { "apertura": "10:00", "cierre": "19:00" },
    "jueves":    { "apertura": "10:00", "cierre": "19:00" },
    "viernes":   { "apertura": "10:00", "cierre": "19:00" },
    "sabado":    { "apertura": "10:00", "cierre": "19:00" }
  }'::JSONB,
  'Un momento, te paso con alguien del equipo.'
)
ON CONFLICT (organization_id) DO NOTHING;

-- Configuración general
INSERT INTO config (organization_id, clave, valor) VALUES
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'bot_activo', 'true'),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'horas_resena', '2'),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'cancelacion_horas', '48')
ON CONFLICT (organization_id, clave) DO NOTHING;
