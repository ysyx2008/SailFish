import type { ToolDefinition } from '../../tools'

export const pdfTools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'pdf_view_page',
      description: 'Render specific pages of a scanned/image-based PDF as images for visual analysis. Use this when read_file reports a scanned PDF and you need to view additional pages. Pages are numbered from 1. You can request multiple pages at once.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute path to the PDF file'
          },
          pages: {
            type: 'array',
            items: { type: 'number' },
            description: 'Page numbers to render (1-based). Example: [1, 2, 3]'
          }
        },
        required: ['path', 'pages']
      }
    }
  }
]
