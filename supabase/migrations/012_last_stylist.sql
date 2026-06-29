-- Columna para recordar la estilista de la última visita de cada contacto.
-- Se actualiza al confirmar una reserva y se usa en el prompt para personalizar
-- la pregunta de selección de estilista.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_stylist text;
