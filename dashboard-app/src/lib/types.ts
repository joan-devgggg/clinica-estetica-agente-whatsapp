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
  bot_mode?: "auto" | "manual";
  origen?: string;
  preferred_stylist_id?: string;
  language?: string;
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
  origen?: string;
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
