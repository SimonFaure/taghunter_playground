export interface ApiEndpoint {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  description: string;
  parameters: {
    name: string;
    type: string;
    required: boolean;
    description: string;
  }[];
  exampleRequest: string;
  exampleResponse: string;
  statusCodes: {
    code: number;
    description: string;
  }[];
}

export const apiEndpoints: ApiEndpoint[] = [
  {
    name: 'Get Billing Status',
    method: 'GET',
    path: '/backend/api/playground.php?action=get_billing_status',
    description: 'Retrieves the billing status and license information for a user based on their email address.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=get_billing_status&email=user@example.com',
    exampleResponse: `{
  "billing_up_to_date": true,
  "license_type": "premium"
}`,
    statusCodes: [
      { code: 200, description: 'Success - Returns billing status' },
      { code: 400, description: 'Bad Request - Missing or invalid email parameter' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Get Cards Version',
    method: 'GET',
    path: '/backend/api/playground.php?action=get_cards_version',
    description: 'Retrieves the current version number of the cards database available for download.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=get_cards_version&email=user@example.com',
    exampleResponse: `{
  "version": 5
}`,
    statusCodes: [
      { code: 200, description: 'Success - Returns version number' },
      { code: 400, description: 'Bad Request - Missing or invalid email parameter' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Get Patterns',
    method: 'GET',
    path: '/backend/api/playground.php?action=get_patterns',
    description: 'Retrieves all available pattern configurations for all game types.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=get_patterns&email=user@example.com',
    exampleResponse: `{
  "patterns": [
    {
      "slug": "ado_adultes",
      "name": "Teen/Adult Pattern",
      "version": 3,
      "type": "default",
      "download_url": "https://example.com/patterns/mystery/ado_adultes_v3.csv"
    },
    {
      "slug": "kids",
      "name": "Kids Pattern",
      "version": 2,
      "type": "user",
      "download_url": "https://example.com/patterns/mystery/kids_v2.csv"
    }
  ]
}`,
    statusCodes: [
      { code: 200, description: 'Success - Returns list of patterns' },
      { code: 400, description: 'Bad Request - Missing required parameters' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Get Layouts',
    method: 'GET',
    path: '/backend/api/playground.php?action=get_layouts',
    description: 'Retrieves all available layout configurations for all game types.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=get_layouts&email=user@example.com',
    exampleResponse: `{
  "layouts": [
    {
      "game_type": "mystery",
      "version": 4,
      "download_url": "https://example.com/layouts/mystery_v4.json"
    },
    {
      "game_type": "treasure_hunt",
      "version": 2,
      "download_url": "https://example.com/layouts/treasure_hunt_v2.json"
    }
  ]
}`,
    statusCodes: [
      { code: 200, description: 'Success - Returns list of layouts' },
      { code: 400, description: 'Bad Request - Missing required parameters' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Get User Data Update',
    method: 'GET',
    path: '/backend/api/playground.php?action=get_user_data_update',
    description: 'Unified endpoint that retrieves all user data in a single request: scenarios, patterns, layouts, and cards version. This replaces multiple individual API calls and reduces network overhead.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=get_user_data_update&email=user@example.com',
    exampleResponse: `{
  "custom_scenarios": [
    {
      "title": "My Scenario",
      "slug": "my-scenario",
      "uniqid": "scenario_abc123",
      "version": "1.2",
      "game_type": "mystery"
    }
  ],
  "product_scenarios": [
    {
      "title": "Product Scenario",
      "slug": "product-scenario",
      "uniqid": "scenario_def456",
      "version": "2.0",
      "game_type": "treasure_hunt"
    }
  ],
  "default_patterns": [
    {
      "name": "Default Pattern",
      "game_type": "taghunter",
      "version": "1.0",
      "uniqid": "pattern_xyz789"
    }
  ],
  "custom_patterns": [
    {
      "name": "My Pattern",
      "game_type": "taghunter",
      "version": "1.0",
      "uniqid": "pattern_abc456"
    }
  ],
  "cards_version": 3,
  "has_on_demand_cards": true,
  "layouts": [
    {
      "id": 1,
      "version": "1.0",
      "game_type": "taghunter"
    }
  ],
  "billing_up_to_date": true,
  "license_type": "premium"
}`,
    statusCodes: [
      { code: 200, description: 'Success - Returns all user data' },
      { code: 400, description: 'Bad Request - Missing or invalid email parameter' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Download Pattern',
    method: 'GET',
    path: '/backend/api/playground.php?action=download_pattern',
    description: 'Downloads a specific pattern file by its unique ID.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      },
      {
        name: 'pattern_uniqid',
        type: 'string',
        required: true,
        description: 'The unique identifier of the pattern'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=download_pattern&email=user@example.com&pattern_uniqid=pattern_xyz789',
    exampleResponse: 'CSV file content containing pattern data',
    statusCodes: [
      { code: 200, description: 'Success - Returns pattern file' },
      { code: 400, description: 'Bad Request - Missing required parameters' },
      { code: 404, description: 'Not Found - Pattern does not exist' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Download Cards',
    method: 'GET',
    path: '/backend/api/playground.php?action=download_cards',
    description: 'Downloads the cards database file for a specific version.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      },
      {
        name: 'version',
        type: 'number',
        required: true,
        description: 'The version number of the cards to download'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=download_cards&email=user@example.com&version=3',
    exampleResponse: 'CSV file content containing cards data',
    statusCodes: [
      { code: 200, description: 'Success - Returns cards file' },
      { code: 400, description: 'Bad Request - Missing required parameters' },
      { code: 404, description: 'Not Found - Cards version does not exist' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Download Layout',
    method: 'GET',
    path: '/backend/api/playground.php?action=download_layout',
    description: 'Downloads a specific layout file by its ID.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      },
      {
        name: 'layout_id',
        type: 'number',
        required: true,
        description: 'The unique identifier of the layout'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=download_layout&email=user@example.com&layout_id=1',
    exampleResponse: 'JSON file content containing layout configuration',
    statusCodes: [
      { code: 200, description: 'Success - Returns layout file' },
      { code: 400, description: 'Bad Request - Missing required parameters' },
      { code: 404, description: 'Not Found - Layout does not exist' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Get User Scenarios',
    method: 'GET',
    path: '/backend/api/playground.php?action=get_user_scenarios',
    description: 'Retrieves all scenarios available for a specific user based on their email address.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=get_user_scenarios&email=user@example.com',
    exampleResponse: `{
  "scenarios": [
    {
      "id": 5,
      "title": "Product Scenario",
      "description": "Available for purchase",
      "game_type": "puzzle",
      "scenario_type": "product",
      "uniqid": "scenario_674fb123a45e6"
    }
  ]
}`,
    statusCodes: [
      { code: 200, description: 'Success - Returns list of scenarios' },
      { code: 400, description: 'Bad Request - Missing or invalid email parameter' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Get Scenario Game Data',
    method: 'GET',
    path: '/backend/api/playground.php?action=get_scenario_game_data',
    description: 'Retrieves the complete game data for a specific scenario including metadata, enigmas, media references, and configuration.',
    parameters: [
      {
        name: 'email',
        type: 'string',
        required: true,
        description: 'The email address of the user'
      },
      {
        name: 'uniqid',
        type: 'string',
        required: true,
        description: 'The unique identifier of the scenario'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=get_scenario_game_data&email=user@example.com&uniqid=scenario_674fb123a45e6',
    exampleResponse: `{
  "id": 5,
  "uniqid": "scenario_674fb123a45e6",
  "title": "Product Scenario",
  "description": "Available for purchase",
  "game_type": "puzzle",
  "scenario_type": "product",
  "duration_minutes": 60,
  "difficulty": "medium",
  "media": [
    {
      "filename": "image1.jpg",
      "folder": "images"
    },
    {
      "filename": "sound1.mp3",
      "folder": "sounds"
    }
  ],
  "enigmas": [
    {
      "id": 1,
      "title": "First Puzzle",
      "description": "Solve this puzzle",
      "solution": "ANSWER"
    }
  ]
}`,
    statusCodes: [
      { code: 200, description: 'Success - Returns complete game data' },
      { code: 400, description: 'Bad Request - Missing required parameters' },
      { code: 404, description: 'Not Found - Scenario does not exist or user does not have access' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Get Media File',
    method: 'GET',
    path: '/backend/api/playground.php?action=get_media',
    description: 'Downloads a specific media file (image, sound, video) associated with a scenario.',
    parameters: [
      {
        name: 'uniqid',
        type: 'string',
        required: true,
        description: 'The unique identifier of the scenario'
      },
      {
        name: 'filename',
        type: 'string',
        required: true,
        description: 'The name of the media file to download'
      }
    ],
    exampleRequest: 'GET https://admin.taghunter.fr/backend/api/playground.php?action=get_media&uniqid=scenario_674fb123a45e6&filename=image1.jpg',
    exampleResponse: 'Binary file content (image, audio, or video)',
    statusCodes: [
      { code: 200, description: 'Success - Returns the media file' },
      { code: 400, description: 'Bad Request - Missing required parameters' },
      { code: 404, description: 'Not Found - Media file does not exist' },
      { code: 500, description: 'Server Error - Internal server error' }
    ]
  },
  {
    name: 'Start Game Session',
    method: 'POST',
    path: '/api/launched-games',
    description: 'Creates a new game session when a game is launched. Stores the game configuration and initial state.',
    parameters: [
      {
        name: 'uniqid',
        type: 'string',
        required: true,
        description: 'The unique identifier of the scenario'
      },
      {
        name: 'game_name',
        type: 'string',
        required: true,
        description: 'Name of the game'
      },
      {
        name: 'pattern_name',
        type: 'string',
        required: true,
        description: 'Pattern configuration name'
      },
      {
        name: 'num_teams',
        type: 'number',
        required: true,
        description: 'Number of teams playing'
      }
    ],
    exampleRequest: `POST /api/launched-games
Content-Type: application/json

{
  "uniqid": "scenario_674fb123a45e6",
  "game_name": "Mystery Hunt",
  "pattern_name": "ado_adultes",
  "num_teams": 4
}`,
    exampleResponse: `{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "uniqid": "scenario_674fb123a45e6",
  "game_name": "Mystery Hunt",
  "status": "active",
  "created_at": "2024-01-20T10:30:00Z"
}`,
    statusCodes: [
      { code: 201, description: 'Created - Game session created successfully' },
      { code: 400, description: 'Bad Request - Invalid or missing parameters' },
      { code: 500, description: 'Server Error - Failed to create game session' }
    ]
  },
  {
    name: 'Update Game Session',
    method: 'PUT',
    path: '/api/launched-games/:id',
    description: 'Updates an existing game session with new data such as team scores, progress, or status.',
    parameters: [
      {
        name: 'id',
        type: 'string',
        required: true,
        description: 'The unique identifier of the game session'
      },
      {
        name: 'status',
        type: 'string',
        required: false,
        description: 'Game status (active, paused, completed)'
      },
      {
        name: 'teams_data',
        type: 'object',
        required: false,
        description: 'Updated team information and scores'
      }
    ],
    exampleRequest: `PUT /api/launched-games/123e4567-e89b-12d3-a456-426614174000
Content-Type: application/json

{
  "status": "completed",
  "teams_data": {
    "team1": {
      "score": 100,
      "completed_time": "45:30"
    }
  }
}`,
    exampleResponse: `{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "status": "completed",
  "updated_at": "2024-01-20T11:15:30Z"
}`,
    statusCodes: [
      { code: 200, description: 'Success - Game session updated' },
      { code: 400, description: 'Bad Request - Invalid data' },
      { code: 404, description: 'Not Found - Game session does not exist' },
      { code: 500, description: 'Server Error - Failed to update game session' }
    ]
  },
  {
    name: 'Get Game Sessions',
    method: 'GET',
    path: '/api/launched-games',
    description: 'Retrieves a list of all game sessions, optionally filtered by status or date range.',
    parameters: [
      {
        name: 'status',
        type: 'string',
        required: false,
        description: 'Filter by game status (active, completed, paused)'
      },
      {
        name: 'limit',
        type: 'number',
        required: false,
        description: 'Maximum number of results to return'
      }
    ],
    exampleRequest: 'GET /api/launched-games?status=active&limit=10',
    exampleResponse: `[
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "uniqid": "scenario_674fb123a45e6",
    "game_name": "Mystery Hunt",
    "status": "active",
    "created_at": "2024-01-20T10:30:00Z"
  }
]`,
    statusCodes: [
      { code: 200, description: 'Success - Returns list of game sessions' },
      { code: 500, description: 'Server Error - Failed to retrieve game sessions' }
    ]
  },
  {
    name: 'Record Card Read',
    method: 'POST',
    path: '/api/card-reads',
    description: 'Records when a team scans/reads an RFID card during gameplay.',
    parameters: [
      {
        name: 'game_id',
        type: 'string',
        required: true,
        description: 'The game session identifier'
      },
      {
        name: 'team_id',
        type: 'string',
        required: true,
        description: 'The team identifier'
      },
      {
        name: 'card_id',
        type: 'string',
        required: true,
        description: 'The RFID card identifier'
      },
      {
        name: 'timestamp',
        type: 'string',
        required: true,
        description: 'When the card was read (ISO 8601 format)'
      }
    ],
    exampleRequest: `POST /api/card-reads
Content-Type: application/json

{
  "game_id": "123e4567-e89b-12d3-a456-426614174000",
  "team_id": "team_1",
  "card_id": "A4B5C6D7",
  "timestamp": "2024-01-20T10:45:12Z"
}`,
    exampleResponse: `{
  "success": true,
  "message": "Card read recorded",
  "is_valid": true,
  "points_awarded": 10
}`,
    statusCodes: [
      { code: 200, description: 'Success - Card read recorded' },
      { code: 400, description: 'Bad Request - Invalid parameters' },
      { code: 404, description: 'Not Found - Game or team not found' },
      { code: 500, description: 'Server Error - Failed to record card read' }
    ]
  }
];
