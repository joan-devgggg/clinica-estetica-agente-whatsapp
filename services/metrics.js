const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

const METRICS_PATH = path.join(__dirname, '..', 'metrics.json');
const FLUSH_INTERVAL_MS = 30 * 1000; // Escribir a disco cada 30 segundos

// Estado en memoria — operaciones instantáneas y sin race conditions
let metricsCache = {
  leadsDetected: 0,
  leadsSaved: 0,
  fallbacksUsed: 0,
  fieldMisses: {},
  // Nuevas métricas de conversión
  conversationStarted: 0,
  userReplied: 0,
  botQuestion: 0,
  conversationDropped: 0,
  leadCompleted: 0,
  objecionesDetectadas: 0,
  // Tracking por paso
  step_tipo_reforma: 0,
  step_zona: 0,
  step_presupuesto: 0,
  step_nombre: 0,
  step_telefono: 0,
  // Tracking por campo capturado
  dataCaptured_nombre: 0,
  dataCaptured_telefono: 0,
  dataCaptured_tipo_reforma: 0,
  dataCaptured_zona: 0,
  dataCaptured_presupuesto: 0,
  // Tracking por variante A/B
  variants: {
    A: { leads: 0, messages: 0, conversions: 0 },
    B: { leads: 0, messages: 0, conversions: 0 }
  },
  // Tiempos de conversión
  conversionTimes: [],
  // Mensajes clave para análisis
  keyMessages: []
};
let isDirty = false;

// Carga inicial desde disco (solo al arrancar)
function loadMetrics() {
  try {
    const data = JSON.parse(fs.readFileSync(METRICS_PATH, 'utf8'));
    metricsCache = { ...metricsCache, ...data };
  } catch {
    // Archivo no existe o corrupto — empezar desde cero
    logger.warn('metrics_init', { motivo: 'metrics.json no encontrado o corrupto — iniciando métricas en cero' });
  }
}

// Escritura asíncrona a disco (no bloquea el event loop)
async function flushToDisk() {
  if (!isDirty) return;
  try {
    // Calcular métricas derivadas antes de guardar
    const derivedMetrics = calculateDerivedMetrics();
    const metricsToSave = { ...metricsCache, ...derivedMetrics };
    await fs.promises.writeFile(METRICS_PATH, JSON.stringify(metricsToSave, null, 2));
    isDirty = false;
  } catch (error) {
    logger.error('metrics_write_error', { error: error.message });
  }
}

// Calcular métricas derivadas
function calculateDerivedMetrics() {
  const totalConversations = metricsCache.conversationStarted || 1;
  const conversionRate = (metricsCache.leadCompleted / totalConversations) * 100;
  const dropOffRate = (metricsCache.conversationDropped / totalConversations) * 100;
  
  const avgTimeToConvert = metricsCache.conversionTimes.length > 0
    ? metricsCache.conversionTimes.reduce((a, b) => a + b, 0) / metricsCache.conversionTimes.length
    : 0;
  
  return {
    conversionRate: conversionRate.toFixed(2),
    dropOffRate: dropOffRate.toFixed(2),
    averageTimeToConvert: Math.round(avgTimeToConvert),
    totalConversations
  };
}

// Cargar al iniciar el módulo
loadMetrics();

// Flush periódico — no bloquea nada
setInterval(flushToDisk, FLUSH_INTERVAL_MS);

// Flush al cerrar el proceso limpiamente
process.on('SIGINT', async () => { await flushToDisk(); process.exit(0); });
process.on('SIGTERM', async () => { await flushToDisk(); process.exit(0); });

function incrementMetric(key, amount = 1) {
  metricsCache[key] = (metricsCache[key] || 0) + amount;
  isDirty = true;
}

function incrementFieldMiss(field) {
  metricsCache.fieldMisses = metricsCache.fieldMisses || {};
  metricsCache.fieldMisses[field] = (metricsCache.fieldMisses[field] || 0) + 1;
  isDirty = true;
}

function incrementVariantMetric(variant, metric, amount = 1) {
  if (!metricsCache.variants[variant]) {
    metricsCache.variants[variant] = { leads: 0, messages: 0, conversions: 0 };
  }
  metricsCache.variants[variant][metric] = (metricsCache.variants[variant][metric] || 0) + amount;
  isDirty = true;
}

function recordConversionTime(timeMs) {
  metricsCache.conversionTimes.push(timeMs);
  // Mantener solo los últimos 1000 para no crecer indefinidamente
  if (metricsCache.conversionTimes.length > 1000) {
    metricsCache.conversionTimes = metricsCache.conversionTimes.slice(-1000);
  }
  isDirty = true;
}

function recordKeyMessage(type, message) {
  metricsCache.keyMessages.push({
    type,
    message,
    timestamp: new Date().toISOString()
  });
  // Mantener solo los últimos 500 mensajes clave
  if (metricsCache.keyMessages.length > 500) {
    metricsCache.keyMessages = metricsCache.keyMessages.slice(-500);
  }
  isDirty = true;
}

module.exports = { 
  incrementMetric, 
  incrementFieldMiss, 
  incrementVariantMetric,
  recordConversionTime,
  recordKeyMessage,
  calculateDerivedMetrics
};
