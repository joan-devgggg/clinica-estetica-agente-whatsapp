// Estado de la hora de cita en la ficha de cliente.
//
// El sheet de edición está montado de forma permanente en la página (recibe `cliente`
// como prop y devuelve null cuando es null), así que un `useState(cliente?.hora_cita)`
// solo se evalúa UNA vez —con cliente todavía null— y se queda en "" para siempre: cada
// guardado mandaba hora_cita:"" y borraba la hora de la cita. Aquí se deriva el estado del
// cliente seleccionado: al cambiar de ficha se re-siembra con su hora; mientras se edita la
// MISMA ficha se conserva intacto lo que haya elegido la usuaria.

export type HoraCitaState = {
  clienteId: string | number | null;
  hora: string;
};

export const INITIAL_HORA_CITA: HoraCitaState = { clienteId: null, hora: "" };

export function syncHoraCita(
  state: HoraCitaState,
  cliente: { id: string | number; hora_cita?: string | null } | null
): HoraCitaState {
  const clienteId = cliente?.id ?? null;
  if (state.clienteId === clienteId) return state;
  return { clienteId, hora: cliente?.hora_cita ?? "" };
}
