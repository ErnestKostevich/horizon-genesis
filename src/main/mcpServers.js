'use strict';
/**
 * Horizon AI — MCP (Model Context Protocol) Integration
 * 
 * Provides integration with external services:
 * - Gmail (read, send, search emails)
 * - Google Calendar (events, create, update)
 * - File system operations
 * - Web browsing
 */

const { exec } = require('child_process');
const https = require('https');
const http = require('http');

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP REQUEST HELPER
// ═══════════════════════════════════════════════════════════════════════════════

function httpRequest(options, data = null) {
  return new Promise((resolve, reject) => {
    const protocol = options.protocol === 'http:' ? http : https;
    const req = protocol.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(body) });
        } catch {
          resolve({ status: res.statusCode, data: body });
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (data) req.write(typeof data === 'string' ? data : JSON.stringify(data));
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// GMAIL MCP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

class GmailMCP {
  constructor(accessToken) {
    this.token = accessToken;
    this.baseUrl = 'gmail.googleapis.com';
  }

  async _request(endpoint, method = 'GET', body = null) {
    const options = {
      hostname: this.baseUrl,
      path: `/gmail/v1/users/me${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    return httpRequest(options, body);
  }

  /**
   * List recent emails
   */
  async listEmails(query = '', maxResults = 10) {
    try {
      const q = query ? `&q=${encodeURIComponent(query)}` : '';
      const res = await this._request(`/messages?maxResults=${maxResults}${q}`);
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed' };
      
      // Get details for each message
      const messages = [];
      for (const msg of (res.data.messages || []).slice(0, maxResults)) {
        const detail = await this._request(`/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        if (detail.status === 200) {
          const headers = detail.data.payload?.headers || [];
          messages.push({
            id: msg.id,
            threadId: msg.threadId,
            from: headers.find(h => h.name === 'From')?.value || '',
            subject: headers.find(h => h.name === 'Subject')?.value || '',
            date: headers.find(h => h.name === 'Date')?.value || '',
            snippet: detail.data.snippet || ''
          });
        }
      }
      return { ok: true, messages };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Read full email by ID
   */
  async readEmail(messageId) {
    try {
      const res = await this._request(`/messages/${messageId}?format=full`);
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed' };
      
      const headers = res.data.payload?.headers || [];
      let body = '';
      
      // Extract body from parts
      const extractBody = (part) => {
        if (part.body?.data) {
          body += Buffer.from(part.body.data, 'base64url').toString('utf8');
        }
        if (part.parts) {
          part.parts.forEach(extractBody);
        }
      };
      extractBody(res.data.payload);
      
      return {
        ok: true,
        email: {
          id: messageId,
          from: headers.find(h => h.name === 'From')?.value || '',
          to: headers.find(h => h.name === 'To')?.value || '',
          subject: headers.find(h => h.name === 'Subject')?.value || '',
          date: headers.find(h => h.name === 'Date')?.value || '',
          body: body.slice(0, 10000) // Limit body length
        }
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Send email
   */
  async sendEmail(to, subject, body, cc = '', bcc = '') {
    try {
      const email = [
        `To: ${to}`,
        cc ? `Cc: ${cc}` : '',
        bcc ? `Bcc: ${bcc}` : '',
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=utf-8',
        '',
        body
      ].filter(Boolean).join('\r\n');

      const encodedEmail = Buffer.from(email).toString('base64url');
      const res = await this._request('/messages/send', 'POST', { raw: encodedEmail });
      
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed to send' };
      return { ok: true, messageId: res.data.id };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Search emails
   */
  async searchEmails(query, maxResults = 20) {
    return this.listEmails(query, maxResults);
  }

  /**
   * Get unread count
   */
  async getUnreadCount() {
    try {
      const res = await this._request('/labels/UNREAD');
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed' };
      return { ok: true, count: res.data.messagesUnread || 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// GOOGLE CALENDAR MCP SERVER
// ═══════════════════════════════════════════════════════════════════════════════

class CalendarMCP {
  constructor(accessToken) {
    this.token = accessToken;
    this.baseUrl = 'www.googleapis.com';
  }

  async _request(endpoint, method = 'GET', body = null) {
    const options = {
      hostname: this.baseUrl,
      path: `/calendar/v3${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      }
    };
    return httpRequest(options, body);
  }

  /**
   * List upcoming events
   */
  async listEvents(calendarId = 'primary', maxResults = 10, timeMin = null) {
    try {
      const now = timeMin || new Date().toISOString();
      const res = await this._request(
        `/calendars/${encodeURIComponent(calendarId)}/events?maxResults=${maxResults}&timeMin=${encodeURIComponent(now)}&singleEvents=true&orderBy=startTime`
      );
      
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed' };
      
      const events = (res.data.items || []).map(e => ({
        id: e.id,
        summary: e.summary || 'No title',
        description: e.description || '',
        location: e.location || '',
        start: e.start?.dateTime || e.start?.date || '',
        end: e.end?.dateTime || e.end?.date || '',
        attendees: (e.attendees || []).map(a => a.email)
      }));
      
      return { ok: true, events };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Get today's events
   */
  async getTodayEvents(calendarId = 'primary') {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    try {
      const res = await this._request(
        `/calendars/${encodeURIComponent(calendarId)}/events?timeMin=${encodeURIComponent(today.toISOString())}&timeMax=${encodeURIComponent(tomorrow.toISOString())}&singleEvents=true&orderBy=startTime`
      );
      
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed' };
      
      return { ok: true, events: res.data.items || [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Create event
   */
  async createEvent(calendarId = 'primary', summary, startTime, endTime, description = '', location = '', attendees = []) {
    try {
      const event = {
        summary,
        description,
        location,
        start: { dateTime: startTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        end: { dateTime: endTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        attendees: attendees.map(email => ({ email }))
      };
      
      const res = await this._request(`/calendars/${encodeURIComponent(calendarId)}/events`, 'POST', event);
      
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed' };
      return { ok: true, eventId: res.data.id, htmlLink: res.data.htmlLink };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Quick add event (natural language)
   */
  async quickAdd(calendarId = 'primary', text) {
    try {
      const res = await this._request(
        `/calendars/${encodeURIComponent(calendarId)}/events/quickAdd?text=${encodeURIComponent(text)}`,
        'POST'
      );
      
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed' };
      return { ok: true, eventId: res.data.id, summary: res.data.summary };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Delete event
   */
  async deleteEvent(calendarId = 'primary', eventId) {
    try {
      const res = await this._request(`/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, 'DELETE');
      return { ok: res.status === 204, error: res.status !== 204 ? 'Failed to delete' : null };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /**
   * Get free/busy times
   */
  async getFreeBusy(timeMin, timeMax, calendars = ['primary']) {
    try {
      const body = {
        timeMin,
        timeMax,
        items: calendars.map(id => ({ id }))
      };
      
      const res = await this._request('/freeBusy', 'POST', body);
      if (res.status !== 200) return { ok: false, error: res.data?.error?.message || 'Failed' };
      
      return { ok: true, calendars: res.data.calendars || {} };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOCATION AWARENESS (IP-based)
// ═══════════════════════════════════════════════════════════════════════════════

class LocationMCP {
  constructor() {
    this.cachedLocation = null;
    this.cacheTime = 0;
    this.cacheDuration = 300000; // 5 minutes
  }

  async getLocation() {
    // Return cached if fresh
    if (this.cachedLocation && Date.now() - this.cacheTime < this.cacheDuration) {
      return { ok: true, ...this.cachedLocation };
    }

    try {
      // Try ip-api.com (free, no key required)
      const res = await httpRequest({
        hostname: 'ip-api.com',
        path: '/json/?fields=status,country,regionName,city,zip,lat,lon,timezone,isp,query',
        method: 'GET'
      });

      if (res.data?.status === 'success') {
        this.cachedLocation = {
          ip: res.data.query,
          country: res.data.country,
          region: res.data.regionName,
          city: res.data.city,
          zip: res.data.zip,
          lat: res.data.lat,
          lon: res.data.lon,
          timezone: res.data.timezone,
          isp: res.data.isp
        };
        this.cacheTime = Date.now();
        return { ok: true, ...this.cachedLocation };
      }

      // Fallback: ipinfo.io
      const fallback = await httpRequest({
        hostname: 'ipinfo.io',
        path: '/json',
        method: 'GET'
      });

      if (fallback.data?.ip) {
        const [lat, lon] = (fallback.data.loc || '0,0').split(',').map(Number);
        this.cachedLocation = {
          ip: fallback.data.ip,
          country: fallback.data.country,
          region: fallback.data.region,
          city: fallback.data.city,
          zip: fallback.data.postal,
          lat,
          lon,
          timezone: fallback.data.timezone,
          isp: fallback.data.org
        };
        this.cacheTime = Date.now();
        return { ok: true, ...this.cachedLocation };
      }

      return { ok: false, error: 'Could not determine location' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async getWeather() {
    try {
      const loc = await this.getLocation();
      if (!loc.ok) return loc;

      // wttr.in - free weather API
      const res = await httpRequest({
        hostname: 'wttr.in',
        path: `/${encodeURIComponent(loc.city)}?format=j1`,
        method: 'GET'
      });

      if (res.data?.current_condition) {
        const current = res.data.current_condition[0];
        const forecast = res.data.weather?.[0];
        
        return {
          ok: true,
          location: `${loc.city}, ${loc.country}`,
          current: {
            temp_c: current.temp_C,
            temp_f: current.temp_F,
            feels_like_c: current.FeelsLikeC,
            humidity: current.humidity,
            description: current.weatherDesc?.[0]?.value || '',
            wind_kmph: current.windspeedKmph,
            wind_dir: current.winddir16Point
          },
          forecast: forecast ? {
            date: forecast.date,
            max_c: forecast.maxtempC,
            min_c: forecast.mintempC,
            sunrise: forecast.astronomy?.[0]?.sunrise,
            sunset: forecast.astronomy?.[0]?.sunset
          } : null
        };
      }

      return { ok: false, error: 'Weather data not available' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async getTimezone() {
    const loc = await this.getLocation();
    if (!loc.ok) return loc;
    
    return {
      ok: true,
      timezone: loc.timezone,
      localTime: new Date().toLocaleString('en-US', { timeZone: loc.timezone }),
      offset: new Date().toLocaleString('en-US', { timeZone: loc.timezone, timeZoneName: 'short' }).split(' ').pop()
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEB SEARCH MCP
// ═══════════════════════════════════════════════════════════════════════════════

class WebSearchMCP {
  constructor(apiKey = null) {
    this.apiKey = apiKey;
  }

  /**
   * DuckDuckGo search (no API key needed)
   */
  async searchDuckDuckGo(query) {
    try {
      const res = await httpRequest({
        hostname: 'api.duckduckgo.com',
        path: `/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
        method: 'GET'
      });

      const results = [];
      
      // Abstract
      if (res.data?.Abstract) {
        results.push({
          title: res.data.Heading || 'Summary',
          snippet: res.data.Abstract,
          url: res.data.AbstractURL || ''
        });
      }
      
      // Related topics
      if (res.data?.RelatedTopics) {
        for (const topic of res.data.RelatedTopics.slice(0, 5)) {
          if (topic.Text) {
            results.push({
              title: topic.Text.split(' - ')[0] || topic.Text.slice(0, 50),
              snippet: topic.Text,
              url: topic.FirstURL || ''
            });
          }
        }
      }

      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: e.message, results: [] };
    }
  }

  /**
   * Wikipedia search
   */
  async searchWikipedia(query, limit = 5) {
    try {
      const res = await httpRequest({
        hostname: 'en.wikipedia.org',
        path: `/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json`,
        method: 'GET'
      });

      if (res.data?.query?.search) {
        return {
          ok: true,
          results: res.data.query.search.map(r => ({
            title: r.title,
            snippet: r.snippet.replace(/<[^>]*>/g, ''), // Remove HTML tags
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`
          }))
        };
      }

      return { ok: true, results: [] };
    } catch (e) {
      return { ok: false, error: e.message, results: [] };
    }
  }

  /**
   * Get Wikipedia article summary
   */
  async getWikipediaSummary(title) {
    try {
      const res = await httpRequest({
        hostname: 'en.wikipedia.org',
        path: `/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        method: 'GET'
      });

      if (res.data?.extract) {
        return {
          ok: true,
          title: res.data.title,
          summary: res.data.extract,
          url: res.data.content_urls?.desktop?.page || ''
        };
      }

      return { ok: false, error: 'Article not found' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// UNIFIED MCP MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

class MCPManager {
  constructor() {
    this.gmail = null;
    this.calendar = null;
    this.location = new LocationMCP();
    this.webSearch = new WebSearchMCP();
  }

  setGmailToken(token) {
    this.gmail = token ? new GmailMCP(token) : null;
  }

  setCalendarToken(token) {
    this.calendar = token ? new CalendarMCP(token) : null;
  }

  // Gmail methods
  async listEmails(query, max) { return this.gmail?.listEmails(query, max) || { ok: false, error: 'Gmail not configured' }; }
  async readEmail(id) { return this.gmail?.readEmail(id) || { ok: false, error: 'Gmail not configured' }; }
  async sendEmail(to, subject, body, cc, bcc) { return this.gmail?.sendEmail(to, subject, body, cc, bcc) || { ok: false, error: 'Gmail not configured' }; }
  async searchEmails(query, max) { return this.gmail?.searchEmails(query, max) || { ok: false, error: 'Gmail not configured' }; }
  async getUnreadCount() { return this.gmail?.getUnreadCount() || { ok: false, error: 'Gmail not configured' }; }

  // Calendar methods
  async listEvents(cal, max, timeMin) { return this.calendar?.listEvents(cal, max, timeMin) || { ok: false, error: 'Calendar not configured' }; }
  async getTodayEvents(cal) { return this.calendar?.getTodayEvents(cal) || { ok: false, error: 'Calendar not configured' }; }
  async createEvent(cal, summary, start, end, desc, loc, attendees) { return this.calendar?.createEvent(cal, summary, start, end, desc, loc, attendees) || { ok: false, error: 'Calendar not configured' }; }
  async quickAddEvent(cal, text) { return this.calendar?.quickAdd(cal, text) || { ok: false, error: 'Calendar not configured' }; }
  async deleteEvent(cal, id) { return this.calendar?.deleteEvent(cal, id) || { ok: false, error: 'Calendar not configured' }; }

  // Location methods
  async getLocation() { return this.location.getLocation(); }
  async getWeather() { return this.location.getWeather(); }
  async getTimezone() { return this.location.getTimezone(); }

  // Web search methods
  async search(query) { return this.webSearch.searchDuckDuckGo(query); }
  async searchWikipedia(query, limit) { return this.webSearch.searchWikipedia(query, limit); }
  async getWikipediaSummary(title) { return this.webSearch.getWikipediaSummary(title); }
}

module.exports = {
  GmailMCP,
  CalendarMCP,
  LocationMCP,
  WebSearchMCP,
  MCPManager
};
