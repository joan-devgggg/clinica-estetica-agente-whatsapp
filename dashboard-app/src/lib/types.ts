export type EstadoCita =
  | "pendiente"
  | "pendiente_bizum"
  | "confirmado"
  | "completado"
  | "cancelado"
  | "abandonado";

export type BizumStatus = "pending" | "confirmed" | "rejected" | "not_required";

export type OrgType = "restaurant" | "salon";

export interface Cliente {
  id: number;
  nombre: string;
  telefono: string;
  personas?: number;
  ocasion?: string;
  estado_cita: EstadoCita;
  fecha_cita?: string;
  hora_cita?: string;
  notas?: string;
  appointment_id?: string;
  is_blacklisted: boolean;
  blacklist_reason?: string;
  is_vip: boolean;
  visit_count: number;
  allergies?: string;
  preferences?: string;
  formula_coloracion?: string;
  bot_mode?: "auto" | "manual";
  origen?: string;
  preferred_stylist_id?: string;
  language?: string;
  /** El idioma se dedujo del nombre (script de clasificación), no se observó escribiendo. */
  language_inferred?: boolean;
  created_at?: string;
  updated_at?: string;
  total_visitas?: number;
  proxima_cita?: string;
  ultima_cita_real?: string;
  ultimo_servicio?: string;
  estilista_nombre?: string;
}

export interface Reserva {
  id: number;
  appointment_id: string;
  nombre: string;
  telefono: string;
  personas?: number;
  ocasion?: string;
  /** `contacts.origen`: de dónde salió la FICHA de esa persona. */
  origen?: string;
  /**
   * `appointments.source`: quién escribió ESTA cita ('web' | 'bot' | 'manual'), en crudo.
   * Se traduce en `@/lib/origen-cita` — nunca aquí, y nunca se confunde con `origen`: una
   * clienta cuya ficha nació por WhatsApp puede haber reservado por el enlace.
   * `null` en una cita antigua sin dato, y entonces NO se pinta nada.
   */
  origen_cita?: string | null;
  bot_mode?: "auto" | "manual";
  is_vip: boolean;
  is_blacklisted: boolean;
  fecha_cita?: string;
  hora_cita?: string;
  estado_cita: string;
  notas?: string;
  bizum_status?: BizumStatus;
  bizum_amount?: number;
  no_show: boolean;
  stylist_id?: string;
  stylist_name?: string;
  service?: string;
  starts_at?: string;
  ends_at?: string;
  // Facturación, SOLO LECTURA desde aquí. El importe se corrige en la pantalla de
  // Facturación (PATCH /api/citas/:id/precio): editar dinero en el mismo formulario que
  // edita el servicio es la confusión que dejó una cita congelada a 220 € cuando valía 260.
  precio_facturado?: number | null;
  precio_manual?: number | null;
  precio_manual_motivo?: string | null;
}

export interface Stylist {
  id: string;
  name: string;
  role: string;
  skills: string[];
  active: boolean;
  created_at?: string;
}

export interface StylistSchedule {
  id: string;
  stylist_id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

export interface ScheduleBlock {
  id: string;
  stylist_id: string;
  starts_at: string;
  ends_at: string;
  reason?: string;
  created_at?: string;
}

export interface BlockedDay {
  id: string;
  organization_id: string;
  stylist_id: string | null;
  fecha: string;
  motivo: string;
  created_at: string;
}

// ─── Caja ───────────────────────────────────────────────────────────────────

export type MetodoCobro = "efectivo" | "tarjeta" | "bizum" | "mixto";
export type MotivoDiferencia = "propina" | "producto" | "descuento" | "servicio_extra" | "otro";
/** confirmada = la estilista metió su PIN · declarada = solo se eligió su nombre. */
export type Atribucion = "confirmada" | "declarada";

export interface Cobro {
  id: string;
  appointment_id: string | null;
  /**
   * De quién es la venta cuando NO hay cita (migración 038). Con cita se queda a null y la
   * clienta sale de la cita: la precedencia la decide `resolveClienteDelCobro` en el servidor,
   * no quien lee este objeto.
   */
  contact_id: string | null;
  cobrado_por: string | null;
  cobrado_por_nombre: string | null;
  fecha_caja: string;
  cobrado_at: string;
  metodo: MetodoCobro;
  importe_total: string | number;
  importe_efectivo: string | number;
  concepto: string | null;
  importe_referencia: string | number | null;
  motivo_diferencia: MotivoDiferencia | null;
  nota: string | null;
  estado: "vigente" | "anulado";
  corrige_a: string | null;
  motivo_correccion: string | null;
  atribucion: Atribucion;
  /** Solo lo devuelve POST /api/cobros cuando la atribución se confirmó: token renovado. */
  cajaToken?: string;
}

/** Una cita del día en la pantalla de caja. `atendio` NO es quien cobra. */
export interface CajaPendiente {
  appointment_id: string;
  cliente: string | null;
  service: string | null;
  starts_at: string;
  estado: string;
  atendio_id: string | null;
  atendio: string | null;
  /** null = de esta cita no hay importe de referencia (servicio sin resolver). */
  importe_referencia: number | null;
  cobro: { id: string; importe_total: string | number; metodo: MetodoCobro; atribucion: Atribucion } | null;
}

interface CajaTramo { num: number; total: number; efectivo: number }

export interface CajaResumenEstilista {
  stylist_id: string | null;
  stylist_name: string | null;
  numCobros: number;
  total: number;
  efectivo: number;
  tarjeta: number;
  confirmada: CajaTramo;
  declarada: CajaTramo;
}

export interface CajaResumen {
  fecha: string;
  estilistas: CajaResumenEstilista[];
  totales: {
    numCobros: number;
    total: number;
    efectivo: number;
    tarjeta: number;
    confirmada: CajaTramo;
    declarada: CajaTramo;
  };
}

export interface StylistPinStatus {
  stylist_id: string;
  actualizado_at: string;
}
