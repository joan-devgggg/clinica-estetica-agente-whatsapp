export type EstadoCita = "pendiente" | "confirmado" | "completado" | "cancelado";

export interface Lead {
  id: number;
  nombre: string;
  telefono: string;
  tratamiento: string;
  estado_cita: EstadoCita;
  fecha_cita?: string;
  hora_cita?: string;
  notas?: string;
  created_at?: string;
}

export interface Cita {
  id: number;
  nombre: string;
  telefono: string;
  tratamiento: string;
  estado_cita: string;
  fecha_cita?: string;
  hora_cita?: string;
  notas?: string;
}
