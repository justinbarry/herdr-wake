herdr-wake: {{agents}} agent pane(s), {{watched}} watched{{#if queued}}, {{queued}} queued{{#if throttled}} (throttled){{/if}}{{/if}}
{{#if auto}}
auto-check: {{auto}}
{{/if}}
{{#each panes}}
- {{pane}} ({{label}}){{#if workspace}} in workspace {{workspace}}{{/if}}: {{status}}{{#if focused}} (focused){{/if}}, {{watch}}{{#if queued}}, queued {{queued}}{{/if}}
{{else}}
No other agent panes are open.
{{/each}}
