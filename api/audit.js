export default async function handler(req, res) {
    // CORS headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
          'Access-Control-Allow-Headers',
          'X-CSRF-Token,X-Requested-With,Accept,Accept-Version,Content-Length,Content-MD5,Content-Type,Date,X-Api-Version'
        );

  if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
  }

  if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
        const { url, type, name, email, company, auditData } = req.body;

      // Handle email capture (from form submission)
      if (type === 'email_capture') {
              console.log(`Email capture: ${email} from ${company}`);
              return res.status(200).json({
                        success: true,
                        message: 'Email captured successfully'
              });
      }

      // Handle audit request
      if (!url) {
              return res.status(400).json({ error: 'URL is required' });
      }

      // Validate URL format
      try {
              new URL(url);
      } catch {
              return res.status(400).json({ error: 'Invalid URL format' });
      }

      // Return mock audit analysis
      const analysis = {
              url: url,
              timestamp: new Date().toISOString(),
              score: 78,
              metrics: {
                        mobileFriendly: true,
                        ssl: url.startsWith('https'),
                        pageSpeed: 'Good',
                        metaTags: 3,
                        headings: 8,
                        imagesAlt: '85%'
              },
              issues: [
                        'Missing meta description',
                        'Images could use better alt text',
                        'Consider adding structured data'
                      ]
      };

      return res.status(200).json(analysis);

  } catch (error) {
        console.error('API error:', error);
        return res.status(500).json({
                error: 'Audit failed',
                message: error.message
        });
  }
}
