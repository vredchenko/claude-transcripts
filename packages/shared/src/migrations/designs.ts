/**
 * CouchDB design documents (map-reduce views) for the sessions database.
 *
 * These are the **authoritative** view definitions. The initial migration
 * (`0001-initial-schema`) installs them; the webapi's boot path applies migrations
 * so views never drift from the doc shapes they map over (ADR 0021). Keep the map
 * functions in sync with the hook's `couchdb/` mirror until that too folds in.
 */

export interface DesignDoc {
  _id: string;
  _rev?: string;
  language: "javascript";
  views: Record<string, { map: string; reduce?: string }>;
}

export const INITIAL_DESIGNS: DesignDoc[] = [
  {
    _id: "_design/sessions",
    language: "javascript",
    views: {
      by_date: {
        map: 'function(doc){if(doc.type==="summary"){var t=doc.timestamp.split(/[-T:]/);emit([parseInt(t[0]),parseInt(t[1]),parseInt(t[2])],{session_id:doc.session_id,event_count:doc.event_count,prompt_count:doc.prompt_count,error_count:doc.error_count,cwd:doc.cwd});}}',
        reduce: "_count",
      },
      by_cwd: {
        map: 'function(doc){if(doc.type==="summary"){emit([doc.cwd,doc.timestamp],{session_id:doc.session_id,event_count:doc.event_count,prompt_count:doc.prompt_count});}}',
        reduce: "_count",
      },
    },
  },
  {
    _id: "_design/events",
    language: "javascript",
    views: {
      by_session: {
        map: 'function(doc){if(doc.type==="event"){emit([doc.session_id,doc.timestamp],{event:doc.event,tool_name:doc.tool_name||null,input_preview:doc.input_preview||doc.prompt_preview||doc.error_preview||null});}}',
      },
      by_type: {
        map: 'function(doc){if(doc.type==="event"){var t=doc.timestamp.split(/[-T:]/);emit([doc.event,parseInt(t[0]),parseInt(t[1]),parseInt(t[2])],1);}}',
        reduce: "_count",
      },
    },
  },
  {
    _id: "_design/tools",
    language: "javascript",
    views: {
      usage: {
        map: 'function(doc){if(doc.type==="event"&&doc.tool_name){var t=doc.timestamp.split(/[-T:]/);emit([doc.tool_name,parseInt(t[0]),parseInt(t[1]),parseInt(t[2])],1);}}',
        reduce: "_count",
      },
      failures: {
        map: 'function(doc){if(doc.event==="PostToolUseFailure"){emit([doc.tool_name,doc.timestamp],{session_id:doc.session_id,error_preview:doc.error_preview,cwd:doc.cwd});}}',
      },
      errors: {
        map: 'function(doc){if(doc.event==="PostToolUseFailure"||doc.error){emit([doc.tool_name||"unknown",doc.timestamp],{session_id:doc.session_id,error_preview:doc.error_preview||doc.error,cwd:doc.cwd});}}',
      },
    },
  },
  {
    _id: "_design/activity",
    language: "javascript",
    views: {
      timeline: {
        map: 'function(doc){if(doc.type==="event"){var t=doc.timestamp.split(/[-T:]/);emit([parseInt(t[0]),parseInt(t[1]),parseInt(t[2]),parseInt(t[3])],1);}}',
        reduce: "_count",
      },
    },
  },
  {
    _id: "_design/chunks",
    language: "javascript",
    views: {
      by_session: {
        map: 'function(doc){if(doc.type==="chunk"){emit([doc.session_id,doc.byte_start],{byte_start:doc.byte_start,byte_end:doc.byte_end,entry_count:doc.entry_count});}}',
      },
      entry_count_by_session: {
        map: 'function(doc){if(doc.type==="chunk"){emit(doc.session_id,doc.entry_count||0);}}',
        reduce: "_sum",
      },
    },
  },
  {
    _id: "_design/session_meta",
    language: "javascript",
    views: {
      start_meta: {
        map: 'function(doc){if(doc.event==="SessionStart"){emit(doc.session_id,{timestamp:doc.timestamp,model:doc.model||"",cwd:doc.cwd||"",hostname:doc.hostname||""});}}',
      },
      tokens_by_date: {
        map: 'function(doc){if(doc.type==="summary"&&doc.token_usage){var t=doc.timestamp.split(/[-T:]/);var u=doc.token_usage;emit([parseInt(t[0]),parseInt(t[1]),parseInt(t[2])],{input:u.input||0,output:u.output||0,cacheCreation:u.cacheCreation||0,cacheRead:u.cacheRead||0,total:u.total||0,sessions:1});}}',
        reduce: "_sum",
      },
    },
  },
];
