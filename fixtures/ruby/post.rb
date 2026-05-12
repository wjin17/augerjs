class Post < ApplicationRecord
  belongs_to :user
  has_many :comments
  has_one :metadata
  has_and_belongs_to_many :tags

  def published?
    published_at.present?
  end

  private

  def notify_subscribers
    # ...
  end
end
