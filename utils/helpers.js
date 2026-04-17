/**
 * iSafe CRM · Utilitários Compartilhados
 * Usado por bling.js, shopify.js, bagy.js — fonte única de verdade.
 */

/**
 * Normaliza número de telefone para o formato E.164 brasileiro: 5548999999999
 * Aceita: (48) 99999-9999 | 48999999999 | 5548999999999 | +5548999999999
 */
function formatPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 13) return digits;          // já no formato correto
  if (digits.length === 12) return digits;          // DDI+DDD+8 dígitos
  if (digits.length === 11) return `55${digits}`;   // DDD+9 dígitos
  if (digits.length === 10) return `55${digits}`;   // DDD+8 dígitos
  if (digits.length >= 8)   return `554800${digits.slice(-8)}`; // fallback SC
  return null;
}

/**
 * Detecta a categoria do produto a partir do nome.
 * Retorna string padronizada usada em filtros e automações.
 */
function detectCategory(productName) {
  if (!productName) return 'outros';
  const p = productName.toLowerCase();
  if (p.includes('iphone'))                                   return 'iPhone';
  if (p.includes('ipad'))                                     return 'iPad';
  if (p.includes('macbook'))                                  return 'MacBook';
  if (p.includes('mac mini') || p.includes('imac'))          return 'Mac';
  if (p.includes('mac'))                                      return 'Mac';
  if (p.includes('airpods'))                                  return 'AirPods';
  if (p.includes('apple watch') || p.includes('watch'))      return 'Apple Watch';
  if (p.includes('acessório') || p.includes('acessorio') ||
      p.includes('capa')      || p.includes('cabo') ||
      p.includes('carregador'))                               return 'Acessório';
  return 'outros';
}

/**
 * Converte data no formato DD/MM/YYYY ou ISO para Date.
 */
function parseDate(dateStr) {
  if (!dateStr) return new Date();
  if (dateStr.includes('/')) {
    const [d, m, y] = dateStr.split('/');
    return new Date(`${y}-${m}-${d}`);
  }
  return new Date(dateStr);
}

/**
 * Promise que aguarda N milissegundos.
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { formatPhone, detectCategory, parseDate, sleep };
