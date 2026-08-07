const asyncHandler = require('../../utils/asyncHandler');
const contentService = require('./content.service');

const getContent = asyncHandler(async (req, res) => {
  const content = await contentService.getAllContent();
  res.json(content);
});

module.exports = { getContent };
